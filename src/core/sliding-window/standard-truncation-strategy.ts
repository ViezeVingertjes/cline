import { Anthropic } from "@anthropic-ai/sdk"
import { ITruncationStrategy } from "./truncation-strategy"

export class StandardTruncationStrategy implements ITruncationStrategy {
	getTruncationRange(
		messages: Anthropic.Messages.MessageParam[],
		currentDeletedRange: [number, number] | undefined,
		keep: "half" | "quarter",
	): [number, number] {
		const rangeStartIndex = 1
		const startOfRest = currentDeletedRange ? currentDeletedRange[1] + 1 : 1

		let messagesToRemove: number
		if (keep === "half") {
			// Remove half of user-assistant pairs
			messagesToRemove = Math.floor((messages.length - startOfRest) / 4) * 2 // Keep even number
		} else {
			// Remove 3/4 of user-assistant pairs
			messagesToRemove = Math.floor((messages.length - startOfRest) / 8) * 3 * 2
		}

		let rangeEndIndex = startOfRest + messagesToRemove - 1

		// Make sure the last message being removed is a user message
		if (messages[rangeEndIndex].role !== "user") {
			rangeEndIndex -= 1
		}

		return [rangeStartIndex, rangeEndIndex]
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
