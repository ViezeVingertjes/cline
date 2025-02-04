import { Anthropic } from "@anthropic-ai/sdk"

export interface ITruncationStrategy {
	getTruncationRange(
		messages: Anthropic.Messages.MessageParam[],
		currentDeletedRange: [number, number] | undefined,
		keep: "half" | "quarter",
	): [number, number]

	truncateMessages(
		messages: Anthropic.Messages.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Anthropic.Messages.MessageParam[]
}
