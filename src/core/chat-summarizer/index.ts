import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "../../api"

type MessageContent =
	| Anthropic.Messages.TextBlockParam
	| Anthropic.Messages.ImageBlockParam
	| Anthropic.Messages.ToolUseBlockParam
	| Anthropic.Messages.ToolResultBlockParam

export class ChatSummarizer {
	private models: ApiHandler
	private maxTokens: number
	private minSplit: number = 4
	private maxDepth: number = 3

	constructor(models: ApiHandler, maxTokens: number = 1024) {
		this.models = models
		this.maxTokens = maxTokens
	}

	async summarize(messages: Anthropic.Messages.MessageParam[]): Promise<Anthropic.Messages.MessageParam[]> {
		if (!this.too_big(messages)) {
			return messages
		}
		return this.summarize_real(messages)
	}

	private async too_big(messages: Anthropic.Messages.MessageParam[]): Promise<boolean> {
		const model = this.models.getModel()
		const totalTokens = messages.reduce((sum, msg) => {
			if (Array.isArray(msg.content)) {
				return (
					sum +
					msg.content.reduce((contentSum: number, block: MessageContent) => {
						if (block.type === "text") {
							return contentSum + block.text.length / 4 // rough token estimation
						}
						return contentSum
					}, 0)
				)
			}
			return sum + (msg.content?.length || 0) / 4 // rough token estimation
		}, 0)
		return totalTokens > this.maxTokens
	}

	private async summarize_real(
		messages: Anthropic.Messages.MessageParam[],
		depth: number = 0,
	): Promise<Anthropic.Messages.MessageParam[]> {
		if (messages.length <= this.minSplit || depth > this.maxDepth) {
			return this.summarize_all(messages)
		}

		// Split messages into head and tail
		const splitPoint = Math.floor(messages.length / 2)
		const head = messages.slice(0, splitPoint)
		const tail = messages.slice(splitPoint)

		// Summarize older messages (head)
		const summarizedHead = await this.summarize_all(head)

		// Combine and check if still too big
		const combined = [...summarizedHead, ...tail]
		if (await this.too_big(combined)) {
			return this.summarize_real(combined, depth + 1)
		}

		return combined
	}

	private async summarize_all(messages: Anthropic.Messages.MessageParam[]): Promise<Anthropic.Messages.MessageParam[]> {
		// Format messages into a structured conversation
		const formattedConversation = messages
			.map((msg) => {
				const role = msg.role.toUpperCase()
				const content = Array.isArray(msg.content)
					? msg.content
							.map((block: MessageContent) => {
								if (block.type === "text") {
									return block.text
								}
								if (block.type === "tool_use") {
									return `[Tool Use: ${block.name}]`
								}
								if (block.type === "tool_result") {
									return `[Tool Result]`
								}
								return ""
							})
							.join("\n")
					: msg.content || ""
				return `${role}: ${content}`
			})
			.join("\n\n")

		// Create a summary using the model
		const summaryPrompt = `*Briefly* summarize this partial conversation about programming.
Include less detail about older parts and more detail about recent messages.
Start a new paragraph for topic changes.

IMPORTANT: This is part of an ongoing conversation, so *DO NOT* conclude the summary with phrases like "Finally..." or "Lastly...".

The summary *MUST* preserve:
- Function names and method signatures
- Libraries and packages
- Filenames referenced in code blocks
- Key technical decisions and architecture choices
- Important error messages or debugging insights

The summary *MUST NOT* include \`\`\`...\`\`\` fenced code blocks!

Write *as* the user in first person, telling the story of our conversation.
Always refer to the assistant as "you" (e.g., "I asked you to...", "you suggested...").
Start the summary with "I asked you...".

Remember: Focus on capturing the technical context and decision-making flow rather than implementation details.

Conversation to summarize:
${formattedConversation}`

		let summaryText = ""
		const stream = this.models.createMessage("", [{ role: "user", content: summaryPrompt }])
		for await (const chunk of stream) {
			if (chunk.type === "text") {
				summaryText += chunk.text
			}
		}

		// Return as a single message
		return [
			{
				role: "assistant",
				content: summaryText,
			},
		]
	}
}
