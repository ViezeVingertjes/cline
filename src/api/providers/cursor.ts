import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "../"
import { ApiHandlerOptions, cursorDefaultModelId, cursorModels, CursorModelId } from "../../shared/api"
import { ApiStream } from "../transform/stream"
import { withRetry } from "../retry"
import { Logger } from "../../services/logging/Logger"
import { convertToCursorMessages } from "../transform/cursor-format"

// Message envelope flags per API spec
const enum EnvelopeFlag {
	NORMAL = 0x00,
	END_STREAM = 0x02,
	ERROR = 0x04,
}

interface MessageContent {
	text: string
}

export class CursorHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private refreshPromise: Promise<void> | null = null
	private lastTokenRefresh: number = 0
	private readonly TOKEN_REFRESH_INTERVAL = 3300000 // 55 minutes in milliseconds
	private readonly TOKEN_EXPIRY = 3600000 // 1 hour in milliseconds
	private readonly MAX_MESSAGE_SIZE = 4294967296 // 4GB (2^32 bytes) per spec
	private readonly CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB"
	private onTokensRefreshed?: (accessToken: string, refreshToken: string) => Promise<void>
	private sessionId: string

	constructor(options: ApiHandlerOptions, onTokensRefreshed?: (accessToken: string, refreshToken: string) => Promise<void>) {
		this.options = options
		this.lastTokenRefresh = Date.now()
		this.onTokensRefreshed = onTokensRefreshed
		this.sessionId = crypto.randomUUID()
	}

	private log(message: string) {
		const timestamp = new Date().toISOString()
		Logger.log(`[CURSOR ${timestamp}] ${message}`)
	}

	private async refreshToken(): Promise<void> {
		if (!this.options.cursorRefreshToken) {
			throw new Error("No refresh token available")
		}

		if (this.refreshPromise) {
			return this.refreshPromise
		}

		this.refreshPromise = (async () => {
			this.log("🔄 Starting token refresh")
			try {
				const response = await fetch("https://cursor.us.auth0.com/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						client_id: this.CLIENT_ID,
						grant_type: "refresh_token",
						refresh_token: this.options.cursorRefreshToken,
					}),
				})

				if (!response.ok) {
					const errorData = await response.json().catch(() => null)
					this.log(`❌ Token refresh failed: ${response.status} ${JSON.stringify(errorData)}`)

					// Handle specific Auth0 error cases
					if (response.status === 401) {
						throw new Error("Authentication failed. Please sign in again.")
					} else if (response.status === 403) {
						throw new Error("Refresh token is invalid or expired. Please sign in again.")
					} else {
						throw new Error(
							`Token refresh failed: ${response.status} ${errorData?.error_description || errorData?.error || "Unknown error"}`,
						)
					}
				}

				const data = await response.json()
				if (!data.access_token) {
					this.log("❌ Invalid response from refresh endpoint - no access token")
					throw new Error("Invalid response from refresh endpoint")
				}

				this.log("✅ Token refresh successful")
				this.options.cursorAccessToken = data.access_token
				this.lastTokenRefresh = Date.now()

				if (this.onTokensRefreshed) {
					await this.onTokensRefreshed(data.access_token, this.options.cursorRefreshToken!)
				}
			} catch (error) {
				this.log(`❌ Token refresh error: ${error}`)
				throw error
			} finally {
				this.refreshPromise = null
			}
		})()

		return this.refreshPromise
	}

	private async validateAndRefreshToken(): Promise<void> {
		const now = Date.now()
		const timeSinceLastRefresh = now - this.lastTokenRefresh

		if (timeSinceLastRefresh >= this.TOKEN_EXPIRY) {
			this.log("⚠️ Access token has expired")
			throw new Error("Access token has expired. Please sign in again.")
		}

		if (timeSinceLastRefresh >= this.TOKEN_REFRESH_INTERVAL) {
			this.log("🔄 Token refresh needed")
			await this.refreshToken()
		}
	}

	private validateEnvelope(buffer: Uint8Array): { isComplete: boolean; totalLength: number; messageLength: number } {
		if (buffer.length < 5) {
			return { isComplete: false, totalLength: 0, messageLength: 0 }
		}

		const flag = buffer[0]
		// Read length as unsigned 32-bit integer in big-endian format
		const messageLength = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false)
		const totalLength = messageLength + 5

		// Log the actual size details for debugging
		this.log(`📏 Envelope details:`)
		this.log(`   Flag: 0x${flag.toString(16)}`)
		this.log(`   Message length: ${messageLength} bytes`)
		this.log(`   Total length with header: ${totalLength} bytes`)
		this.log(`   Current buffer size: ${buffer.length} bytes`)
		this.log(
			`   Raw header: ${Array.from(buffer.slice(0, 5))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(" ")}`,
		)
		this.log(
			`   Raw data: ${Array.from(buffer)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(" ")}`,
		)

		// Validate length before checking completeness
		if (messageLength > this.MAX_MESSAGE_SIZE) {
			throw new Error(`Message size ${messageLength} exceeds maximum allowed size ${this.MAX_MESSAGE_SIZE}`)
		}

		// Check if we have enough data for the complete message
		return {
			isComplete: buffer.length >= totalLength,
			totalLength,
			messageLength,
		}
	}

	private decodeEnvelope(buffer: Uint8Array): { flag: number; data: Uint8Array } {
		if (buffer.length < 5) {
			throw new Error("Invalid data length: too short")
		}

		const flag = buffer[0]
		const messageLength = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false)
		const totalLength = messageLength + 5

		// Validate exact length like Rust implementation
		if (buffer.length !== totalLength) {
			throw new Error(
				`Protocol error: promised ${messageLength} bytes in enveloped message, got ${buffer.length - 5} bytes`,
			)
		}

		// Validate length before returning data
		if (messageLength > this.MAX_MESSAGE_SIZE) {
			throw new Error(`Message size ${messageLength} exceeds maximum allowed size ${this.MAX_MESSAGE_SIZE}`)
		}

		return {
			flag,
			data: buffer.slice(5, totalLength), // Ensure we only take the message length
		}
	}

	private encodeEnvelope(data: Uint8Array | string | object, flag: number = EnvelopeFlag.NORMAL): Uint8Array {
		let dataBytes: Uint8Array
		if (typeof data === "string") {
			dataBytes = new TextEncoder().encode(data)
		} else if (data instanceof Uint8Array) {
			dataBytes = data
		} else {
			// For objects, we want to match Rust's serde_json behavior exactly
			const jsonString = JSON.stringify(data)
			dataBytes = new TextEncoder().encode(jsonString)
		}

		// Validate length before creating envelope
		if (dataBytes.length > this.MAX_MESSAGE_SIZE) {
			throw new Error(`Message size ${dataBytes.length} exceeds maximum allowed size ${this.MAX_MESSAGE_SIZE}`)
		}

		const result = new Uint8Array(5 + dataBytes.length)
		result[0] = flag
		new DataView(result.buffer).setUint32(1, dataBytes.length, false) // false = big-endian
		result.set(dataBytes, 5)
		return result
	}

	private async processMessageChunk(chunk: Uint8Array): Promise<Uint8Array> {
		// Log raw chunk for debugging
		this.log(`🔍 Raw chunk:`)
		this.log(`   Size: ${chunk.length} bytes`)
		this.log(
			`   Raw data: ${Array.from(chunk)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(" ")}`,
		)

		try {
			const text = new TextDecoder().decode(chunk)
			this.log(`   As text: ${text}`)
		} catch (error) {
			this.log(`   Failed to decode as text: ${error}`)
		}

		return chunk
	}

	private parseErrorMessage(data: Uint8Array): string {
		try {
			const errorText = new TextDecoder().decode(data)
			this.log(`🔍 Raw error text: ${errorText}`)
			const errorJson = JSON.parse(errorText)
			// Match Rust's error handling order exactly
			if (errorJson.error?.message) {
				return errorJson.error.message
			} else if (errorJson.error?.code && errorJson.error?.message) {
				return `${errorJson.error.code}: ${errorJson.error.message}`
			}
			return errorText
		} catch (error) {
			this.log(`⚠️ Failed to parse error JSON: ${error}`)
			return new TextDecoder().decode(data)
		}
	}

	private async handleErrorResponse(response: Response): Promise<never> {
		const errorText = await response.text()
		let errorMessage = `Server returned status code ${response.status}`

		try {
			const errorJson = JSON.parse(errorText)
			// Match Rust's error handling order exactly
			if (errorJson.error?.message) {
				errorMessage = errorJson.error.message
			} else if (errorJson.error?.code && errorJson.error?.message) {
				errorMessage = `${errorJson.error.code}: ${errorJson.error.message}`
			}
		} catch {
			// Use the default error message if JSON parsing fails
		}

		throw new Error(errorMessage)
	}

	private parseMessageContent(data: string): MessageContent | null {
		try {
			const content = JSON.parse(data)
			if (content && typeof content.text === "string") {
				return content as MessageContent
			}
			return null
		} catch {
			return null
		}
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		if (!this.options.cursorAccessToken) {
			throw new Error("Cursor access token is required. Please sign in with your Cursor account.")
		}

		await this.validateAndRefreshToken()

		const cursorMessages = convertToCursorMessages(systemPrompt, messages)

		this.log("📤 Sending request with messages:")
		this.log(JSON.stringify(cursorMessages, null, 2))

		const requestBody = {
			query: cursorMessages[cursorMessages.length - 1].text,
			currentFile: {
				contents: "",
				languageId: "typescript",
				relativeWorkspacePath: "",
				selection: {
					startPosition: { line: 0, character: 0 },
					endPosition: { line: 0, character: 0 },
				},
				cursorPosition: { line: 0, character: 0 },
			},
			modelDetails: {
				modelName: this.getModel().id,
				enableGhostMode: false,
				apiKey: undefined,
			},
			workspaceRootPath: "",
			explicitContext: {},
			requestId: crypto.randomUUID(),
			conversation: cursorMessages,
		}

		this.log("📝 Full request body:")
		this.log(JSON.stringify(requestBody, null, 2))

		// Create request envelope like Rust implementation
		const requestEnvelope = this.encodeEnvelope(requestBody) // Pass object directly to match Rust's serialization
		const endMarker = this.encodeEnvelope(new Uint8Array(0), EnvelopeFlag.END_STREAM) // Empty array for end marker

		// Combine envelopes exactly like Rust
		const fullRequestBody = new Uint8Array(requestEnvelope.length + endMarker.length)
		fullRequestBody.set(requestEnvelope)
		fullRequestBody.set(endMarker, requestEnvelope.length)

		this.log("📦 Encoded request body:")
		this.log(`   Size: ${fullRequestBody.length} bytes`)
		this.log(
			`   Raw data: ${Array.from(fullRequestBody)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(" ")}`,
		)

		const response = await fetch("https://api2.cursor.sh/aiserver.v1.AiService/StreamChat", {
			method: "POST",
			headers: {
				Accept: "*/*",
				"Content-Type": "application/connect+json",
				Authorization: `Bearer ${this.options.cursorAccessToken}`,
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/0.45.11 Chrome/128.0.6613.186 Electron/32.2.6 Safari/537.36",
				"x-cursor-client-key": "2a02d8cd9b5af7a8db6e143e201164e47faa7cba6574524e4e4aafe6655f18cf",
				"x-cursor-checksum":
					"LwoMGZe259957470509b69c0a477232e090cae43695725138dedbcc7625a2b36573caa58/deb3cac1988ff56ea6fabce72eefd291235ab451eef8173567d7521126673b73",
				"x-cursor-client-version": "0.45.11",
				"x-cursor-timezone": "Europe/Amsterdam",
				"x-ghost-mode": "false",
				"x-session-id": this.sessionId,
			},
			body: fullRequestBody,
		})

		this.log(`📥 Response status: ${response.status} ${response.statusText}`)
		this.log("📥 Response headers:")
		response.headers.forEach((value, key) => {
			this.log(`   ${key}: ${value}`)
		})

		if (!response.ok) {
			await this.handleErrorResponse(response)
		}

		const reader = response.body?.getReader()
		if (!reader) {
			throw new Error("Failed to get response reader")
		}

		try {
			let buffer = new Uint8Array(0)
			let sawEndMarker = false
			this.log("🔄 Starting message processing stream")

			while (true) {
				const { done, value } = await reader.read()
				if (done) {
					this.log("📥 Stream done")
					break
				}

				const processedChunk = await this.processMessageChunk(value)
				this.log(`📦 Received chunk of size: ${processedChunk.length}`)

				// Append new data to buffer
				const newBuffer = new Uint8Array(buffer.length + processedChunk.length)
				newBuffer.set(buffer)
				newBuffer.set(processedChunk, buffer.length)
				buffer = newBuffer
				this.log(`📎 Buffer size after combining: ${buffer.length}`)

				// Process complete messages
				while (buffer.length >= 5) {
					const { isComplete, totalLength } = this.validateEnvelope(buffer)
					if (!isComplete) {
						this.log(`⏳ Waiting for more data. Have ${buffer.length}, need ${totalLength}`)
						break
					}

					// Extract and decode the complete message
					const completeMessage = buffer.slice(0, totalLength)
					buffer = buffer.slice(totalLength)

					try {
						const { flag, data } = this.decodeEnvelope(completeMessage)
						this.log(`🏷️ Message envelope - Flag: 0x${flag.toString(16)}, Length: ${data.length}`)

						if (flag === EnvelopeFlag.END_STREAM) {
							this.log("🏁 End of stream marker received")
							if (data.length > 0) {
								const errorMessage = this.parseErrorMessage(data)
								if (errorMessage !== "{}") {
									// Don't treat empty object as error
									this.log(`❌ Error in end-of-stream marker: ${errorMessage}`)
									throw new Error(errorMessage)
								}
							}
							sawEndMarker = true
							return
						}

						if (flag === EnvelopeFlag.ERROR) {
							const errorMessage = this.parseErrorMessage(data)
							this.log(`❌ Error message received: ${errorMessage}`)
							throw new Error(errorMessage)
						}

						if (flag === EnvelopeFlag.NORMAL) {
							const messageText = new TextDecoder().decode(data)
							this.log(`📨 Message text: ${messageText}`)

							// Skip empty messages like Rust
							if (messageText.length === 0) {
								this.log(`📝 Skipping empty message`)
								continue
							}

							try {
								const content = this.parseMessageContent(messageText)
								if (content) {
									this.log(`✏️ Yielding text: ${content.text}`)
									// Convert to Anthropic format for our history
									yield {
										type: "text",
										text: content.text,
									}
								} else {
									this.log(`⚠️ Message had no text property: ${messageText}`)
								}
							} catch (error) {
								this.log(`❌ Failed to parse message: ${error}`)
								throw new Error(`Failed to parse message: ${error}`)
							}
						}
					} catch (error) {
						this.log(`❌ Error processing message: ${error}`)
						throw new Error(`Error processing message: ${error}`)
					}
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	getModel() {
		const modelId = this.options.apiModelId
		if (modelId && modelId in cursorModels) {
			const id = modelId as CursorModelId
			return { id, info: cursorModels[id] }
		}
		return {
			id: cursorDefaultModelId,
			info: cursorModels[cursorDefaultModelId],
		}
	}
}
