import { Anthropic } from "@anthropic-ai/sdk"
import { ITruncationStrategy } from "./truncation-strategy"

export class ExperimentalTruncationStrategy implements ITruncationStrategy {
	getTruncationRange(
		messages: Anthropic.Messages.MessageParam[],
		currentDeletedRange: [number, number] | undefined,
		keep: "half" | "quarter",
	): [number, number] {
		const rangeStartIndex = 1
		const startOfRest = currentDeletedRange ? currentDeletedRange[1] + 1 : 1

		// Calculate how many messages to keep based on the keep parameter
		const totalMessages = messages.length - startOfRest
		const messagesToKeep = keep === "half" ? Math.floor(totalMessages / 2) : Math.floor(totalMessages / 4)

		// Keep more recent messages and important ones (those with tool calls or results)
		const scoredMessages = messages.slice(startOfRest).map((msg, idx) => {
			let score = 0
			// Recent messages get higher scores
			score += (messages.length - idx) / messages.length
			// Messages with tool calls or results get bonus points
			if (Array.isArray(msg.content)) {
				const hasToolUse = msg.content.some((block) => block.type === "tool_use")
				if (hasToolUse) {
					score += 0.5
				}
			}
			return { index: startOfRest + idx, score }
		})

		// Sort by score and get indices to remove
		const sortedIndices = scoredMessages
			.sort((a, b) => b.score - a.score)
			.slice(messagesToKeep)
			.map((m) => m.index)
			.sort((a, b) => a - b)

		if (sortedIndices.length === 0) {
			return [rangeStartIndex, rangeStartIndex]
		}

		// Find continuous ranges to remove
		let rangeStart = sortedIndices[0]
		let rangeEnd = sortedIndices[0]

		for (let i = 1; i < sortedIndices.length; i++) {
			if (sortedIndices[i] === rangeEnd + 1) {
				rangeEnd = sortedIndices[i]
			} else {
				break
			}
		}

		return [rangeStart, rangeEnd]
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
