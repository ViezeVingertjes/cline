import { Anthropic } from "@anthropic-ai/sdk"
import { TruncationStrategyManager } from "./truncation-strategy-manager"

// Public API - these functions are used by Cline.ts
export function getNextTruncationRange(
	messages: Anthropic.Messages.MessageParam[],
	currentDeletedRange: [number, number] | undefined = undefined,
	keep: "half" | "quarter" = "half",
): [number, number] {
	const strategy = TruncationStrategyManager.getInstance().getStrategy()
	return strategy.getTruncationRange(messages, currentDeletedRange, keep)
}

export function getTruncatedMessages(
	messages: Anthropic.Messages.MessageParam[],
	deletedRange: [number, number] | undefined,
): Anthropic.Messages.MessageParam[] {
	const strategy = TruncationStrategyManager.getInstance().getStrategy()
	return strategy.truncateMessages(messages, deletedRange)
}

// Export types and implementations for external use if needed
export type { ITruncationStrategy } from "./truncation-strategy"
export { StandardTruncationStrategy } from "./standard-truncation-strategy"
export { ExperimentalTruncationStrategy } from "./experimental-truncation-strategy"
export { TruncationStrategyManager } from "./truncation-strategy-manager"
