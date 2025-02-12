import { vscode } from "../../utils/vscode"
import { CursorConfig } from "../../../../src/shared/config/cursor"

export class CursorAuthError extends Error {
	type: "auth_error" | "network_error" | "timeout_error" | "unknown_error"
	details?: unknown

	constructor(message: string, type: "auth_error" | "network_error" | "timeout_error" | "unknown_error", details?: unknown) {
		super(message)
		this.name = "CursorAuthError"
		this.type = type
		this.details = details
		Object.setPrototypeOf(this, CursorAuthError.prototype)
	}
}

// Constants for token refresh timing
export const TOKEN_REFRESH_INTERVAL = 3300000 // 55 minutes in milliseconds
export const TOKEN_EXPIRY = 3600000 // 1 hour in milliseconds
export const CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB"

/**
 * Generates a PKCE verifier string
 * @returns A random base64URL-encoded string for PKCE verification
 * @throws {Error} If crypto API is not available
 */
export function generatePKCEVerifier(): string {
	if (!window.crypto || !window.crypto.getRandomValues) {
		throw new Error("Crypto API is not available")
	}

	const array = new Uint8Array(32)
	window.crypto.getRandomValues(array)
	const base64 = window.btoa(
		Array.from(array)
			.map((b) => String.fromCharCode(b))
			.join(""),
	)
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/**
 * Generates a PKCE challenge from a verifier
 * @param verifier The PKCE verifier string
 * @returns A base64URL-encoded SHA-256 hash of the verifier
 * @throws {Error} If crypto API is not available
 */
export async function generatePKCEChallenge(verifier: string): Promise<string> {
	if (!window.crypto || !window.crypto.subtle) {
		throw new Error("Crypto API is not available")
	}

	const encoder = new TextEncoder()
	const verifierBytes = encoder.encode(verifier)
	const hashBuffer = await window.crypto.subtle.digest("SHA-256", verifierBytes)
	const base64 = window.btoa(
		Array.from(new Uint8Array(hashBuffer))
			.map((b) => String.fromCharCode(b))
			.join(""),
	)
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/**
 * Initiates the Cursor authentication flow
 * @param onSuccess Callback for successful authentication
 * @param onError Callback for authentication errors
 */
export async function initiateCursorAuth(
	onSuccess: (accessToken: string, refreshToken: string) => void,
	onError: (error: CursorAuthError) => void,
): Promise<void> {
	try {
		const pkceVerifier = generatePKCEVerifier()
		const pkceChallenge = await generatePKCEChallenge(pkceVerifier)
		const uuid = crypto.randomUUID()

		// Log auth flow start for debugging
		vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] ========== AUTH FLOW STARTED ==========" })
		vscode.postMessage({ type: "log", text: `🔐 [CURSOR AUTH] UUID: ${uuid}` })
		vscode.postMessage({ type: "log", text: `🔐 [CURSOR AUTH] Verifier length: ${pkceVerifier.length}` })
		vscode.postMessage({ type: "log", text: `🔐 [CURSOR AUTH] Challenge length: ${pkceChallenge.length}` })

		const loginUrl = `https://cursor.sh/loginDeepControl?challenge=${encodeURIComponent(pkceChallenge)}&uuid=${encodeURIComponent(uuid)}`
		vscode.postMessage({ type: "log", text: `🔐 [CURSOR AUTH] Opening login URL: ${loginUrl}` })

		// Open login URL
		vscode.postMessage({
			type: "openExternalUrl",
			url: loginUrl,
		})

		// Start polling
		vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] Starting polling..." })
		vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] ----------------------------------------" })

		vscode.postMessage({
			type: "pollCursorAuth",
			uuid,
			verifier: pkceVerifier,
		})

		// Set up message handler for auth result
		const handleAuthResult = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "cursorAuthSuccess" && message.access_token && message.refresh_token) {
				window.removeEventListener("message", handleAuthResult)
				vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] ========== AUTH FLOW COMPLETED ==========" })
				onSuccess(message.access_token, message.refresh_token)
			} else if (message.type === "cursorAuthError") {
				window.removeEventListener("message", handleAuthResult)
				vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] ========== AUTH FLOW FAILED ==========" })
				vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] Error: " + message.error })
				onError(new CursorAuthError(message.error || "Authentication failed", "auth_error", message.error))
			}
		}

		window.addEventListener("message", handleAuthResult)

		// Set timeout for auth flow
		setTimeout(() => {
			window.removeEventListener("message", handleAuthResult)
			vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] ========== AUTH FLOW TIMED OUT ==========" })
			vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] No response received - user may have cancelled" })
			onError(new CursorAuthError("Authentication timed out", "timeout_error"))
		}, 30000) // 30 second timeout
	} catch (error) {
		vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] ========== AUTH FLOW FAILED ==========" })
		vscode.postMessage({ type: "log", text: "🔐 [CURSOR AUTH] Error: " + error })
		onError(new CursorAuthError(error instanceof Error ? error.message : "Authentication failed", "unknown_error", error))
	}
}

/**
 * Refreshes the Cursor access token
 * @param refreshToken The refresh token to use
 * @returns The new access token and refresh token
 * @throws {CursorAuthError} If the refresh fails
 */
export async function refreshCursorToken(refreshToken: string): Promise<{ access_token: string }> {
	const response = await fetch(CursorConfig.TOKEN_REFRESH_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": CursorConfig.USER_AGENT,
			"x-cursor-client-key": CursorConfig.CLIENT_KEY,
			"x-cursor-client-version": CursorConfig.CLIENT_VERSION,
		},
		body: JSON.stringify({ refreshToken }),
	})

	if (!response.ok) {
		throw new Error(`Failed to refresh token: ${response.status} ${response.statusText}`)
	}

	return response.json()
}
