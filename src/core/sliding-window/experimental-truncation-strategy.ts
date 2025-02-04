import { Anthropic } from "@anthropic-ai/sdk"
import { ITruncationStrategy } from "./truncation-strategy"

interface ScoredMessage {
	index: number
	score: number
	isUserMessage: boolean
	hasToolUse: boolean
	hasToolResult: boolean
	contentLength: number
	hasCodeBlock: boolean
	hasErrorMessage: boolean
	isPartOfPair: boolean
}

export class ExperimentalTruncationStrategy implements ITruncationStrategy {
	private static readonly TOOL_USE_SCORE = 0.7
	private static readonly TOOL_RESULT_SCORE = 0.6
	private static readonly RECENCY_WEIGHT = 0.4
	private static readonly CONTENT_WEIGHT = 0.3
	private static readonly CODE_BLOCK_SCORE = 0.4
	private static readonly ERROR_MESSAGE_SCORE = 0.5
	private static readonly PAIR_BONUS = 0.3
	private static readonly MIN_MESSAGES_TO_KEEP = 4

	getTruncationRange(
		messages: Anthropic.Messages.MessageParam[],
		currentDeletedRange: [number, number] | undefined,
		keep: "half" | "quarter",
	): [number, number] {
		const rangeStartIndex = 1 // Preserve system message if present
		const startOfRest = currentDeletedRange ? currentDeletedRange[1] + 1 : 1

		// Calculate how many messages to keep based on the keep parameter
		const totalMessages = messages.length - startOfRest
		const rawMessagesToKeep = keep === "half" ? Math.floor(totalMessages / 2) : Math.floor(totalMessages / 4)
		const messagesToKeep = Math.max(rawMessagesToKeep, ExperimentalTruncationStrategy.MIN_MESSAGES_TO_KEEP)

		// Score and analyze messages
		const scoredMessages = this.scoreMessages(messages.slice(startOfRest), startOfRest)

		// Mark message pairs
		this.identifyMessagePairs(scoredMessages, messages.slice(startOfRest))

		// Enhance scores based on context
		this.enhanceScoresBasedOnContext(scoredMessages)

		// Normalize scores
		this.normalizeScores(scoredMessages)

		// Select messages to remove while preserving context
		const indicesToRemove = this.selectMessagesToRemove(scoredMessages, messagesToKeep)

		if (indicesToRemove.length === 0) {
			return [rangeStartIndex, rangeStartIndex]
		}

		// Find optimal continuous range to remove
		const [rangeStart, rangeEnd] = this.findOptimalRemovalRange(indicesToRemove)
		return [rangeStart, rangeEnd]
	}

	private scoreMessages(messages: Anthropic.Messages.MessageParam[], startIndex: number): ScoredMessage[] {
		return messages.map((msg, idx) => {
			const isUserMessage = msg.role === "user"
			let hasToolUse = false
			let hasToolResult = false
			let contentLength = 0
			let hasCodeBlock = false
			let hasErrorMessage = false

			if (Array.isArray(msg.content)) {
				hasToolUse = msg.content.some((block) => {
					return "type" in block && block.type === "tool_use"
				})
				hasToolResult = msg.content.some((block) => {
					return "type" in block && block.type === "tool_result"
				})
				contentLength = msg.content.reduce((len, block) => {
					if (typeof block === "string") {
						const content = block as string
						hasCodeBlock = hasCodeBlock || /\`\`\`[\s\S]+\`\`\`/.test(content)
						hasErrorMessage = hasErrorMessage || /error|exception|failed|traceback/i.test(content)
						return len + content.length
					}
					if ("text" in block && typeof block.text === "string") {
						const content = block.text
						hasCodeBlock = hasCodeBlock || /\`\`\`[\s\S]+\`\`\`/.test(content)
						hasErrorMessage = hasErrorMessage || /error|exception|failed|traceback/i.test(content)
						return len + content.length
					}
					return len
				}, 0)
			} else if (typeof msg.content === "string") {
				const content = msg.content
				hasCodeBlock = /\`\`\`[\s\S]+\`\`\`/.test(content)
				hasErrorMessage = /error|exception|failed|traceback/i.test(content)
				contentLength = content.length
			}

			// Base score calculation
			let score = 0

			// Recency score (0 to RECENCY_WEIGHT)
			score += ((messages.length - idx) / messages.length) * ExperimentalTruncationStrategy.RECENCY_WEIGHT

			// Content length score (0 to CONTENT_WEIGHT)
			const normalizedLength = Math.min(contentLength / 1000, 1)
			score += normalizedLength * ExperimentalTruncationStrategy.CONTENT_WEIGHT

			// Special content scores
			if (hasCodeBlock) {
				score += ExperimentalTruncationStrategy.CODE_BLOCK_SCORE
			}
			if (hasErrorMessage) {
				score += ExperimentalTruncationStrategy.ERROR_MESSAGE_SCORE
			}
			if (hasToolUse) {
				score += ExperimentalTruncationStrategy.TOOL_USE_SCORE
			}
			if (hasToolResult) {
				score += ExperimentalTruncationStrategy.TOOL_RESULT_SCORE
			}

			return {
				index: startIndex + idx,
				score,
				isUserMessage,
				hasToolUse,
				hasToolResult,
				contentLength,
				hasCodeBlock,
				hasErrorMessage,
				isPartOfPair: false,
			}
		})
	}

	private identifyMessagePairs(messages: ScoredMessage[], originalMessages: Anthropic.Messages.MessageParam[]): void {
		for (let i = 0; i < messages.length - 1; i++) {
			const curr = messages[i]
			const next = messages[i + 1]

			// Mark user-assistant pairs
			if (curr.isUserMessage && !next.isUserMessage) {
				curr.isPartOfPair = true
				next.isPartOfPair = true
				continue
			}

			// Mark tool use-result pairs
			if (curr.hasToolUse && next.hasToolResult) {
				curr.isPartOfPair = true
				next.isPartOfPair = true
			}
		}
	}

	private normalizeScores(messages: ScoredMessage[]): void {
		const maxScore = Math.max(
			...messages.map((m) => {
				return m.score
			}),
		)
		if (maxScore > 0) {
			messages.forEach((m) => {
				m.score = m.score / maxScore
				if (m.isPartOfPair) {
					m.score += ExperimentalTruncationStrategy.PAIR_BONUS
				}
				m.score = Math.min(m.score, 1)
			})
		}
	}

	private enhanceScoresBasedOnContext(messages: ScoredMessage[]): void {
		for (let i = 1; i < messages.length - 1; i++) {
			const prev = messages[i - 1]
			const curr = messages[i]
			const next = messages[i + 1]

			// Boost scores for messages between high-scoring neighbors
			const neighborAvgScore = (prev.score + next.score) / 2
			if (neighborAvgScore > 0.7) {
				curr.score *= 1.1
			}

			// Additional boost for messages that are part of a semantic unit
			if ((curr.hasCodeBlock && next.hasErrorMessage) || (curr.hasErrorMessage && next.hasCodeBlock)) {
				curr.score *= 1.15
				next.score *= 1.15
			}
		}
	}

	private selectMessagesToRemove(messages: ScoredMessage[], messagesToKeep: number): number[] {
		// Sort by score descending
		const sortedMessages = [...messages].sort((a, b) => {
			return b.score - a.score
		})

		// Keep the highest scoring messages
		const messagesToRemove = sortedMessages.slice(messagesToKeep)

		// Ensure we're not breaking up important context
		return this.optimizeRemoval(messagesToRemove, messages)
	}

	private optimizeRemoval(messagesToRemove: ScoredMessage[], allMessages: ScoredMessage[]): number[] {
		const removalIndices = new Set(
			messagesToRemove.map((m) => {
				return m.index
			}),
		)

		// Protect message pairs
		for (let i = 0; i < allMessages.length - 1; i++) {
			const curr = allMessages[i]
			const next = allMessages[i + 1]

			if (curr.isPartOfPair && next.isPartOfPair) {
				// If we're trying to remove one message from a pair, protect both
				if (removalIndices.has(curr.index) !== removalIndices.has(next.index)) {
					removalIndices.delete(curr.index)
					removalIndices.delete(next.index)
				}
			}
		}

		return Array.from(removalIndices).sort((a, b) => {
			return a - b
		})
	}

	private findOptimalRemovalRange(indices: number[]): [number, number] {
		if (indices.length === 0) {
			throw new Error("No indices to remove")
		}

		let bestStart = indices[0]
		let bestEnd = indices[0]
		let currentStart = indices[0]
		let currentEnd = indices[0]
		let bestLength = 1
		let currentLength = 1

		for (let i = 1; i < indices.length; i++) {
			if (indices[i] === currentEnd + 1) {
				currentEnd = indices[i]
				currentLength++
				if (currentLength > bestLength) {
					bestLength = currentLength
					bestStart = currentStart
					bestEnd = currentEnd
				}
			} else {
				currentStart = indices[i]
				currentEnd = indices[i]
				currentLength = 1
			}
		}

		return [bestStart, bestEnd]
	}

	truncateMessages(
		messages: Anthropic.Messages.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Anthropic.Messages.MessageParam[] {
		if (!deletedRange) {
			return messages
		}

		const [start, end] = deletedRange
		return [...messages.slice(0, start), ...messages.slice(end + 1)]
	}
}
