import * as vscode from "vscode"
import { ITruncationStrategy } from "./truncation-strategy"
import { StandardTruncationStrategy } from "./standard-truncation-strategy"
import { ExperimentalTruncationStrategy } from "./experimental-truncation-strategy"

export class TruncationStrategyManager {
	private static instance: TruncationStrategyManager
	private currentStrategy: ITruncationStrategy
	private config: vscode.WorkspaceConfiguration

	private constructor() {
		this.config = vscode.workspace.getConfiguration("cline")
		this.currentStrategy = this.createStrategy()

		// Listen for configuration changes
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("cline.experimentalTruncation")) {
				this.config = vscode.workspace.getConfiguration("cline")
				this.currentStrategy = this.createStrategy()
			}
		})
	}

	static getInstance(): TruncationStrategyManager {
		if (!TruncationStrategyManager.instance) {
			TruncationStrategyManager.instance = new TruncationStrategyManager()
		}
		return TruncationStrategyManager.instance
	}

	private createStrategy(): ITruncationStrategy {
		const useExperimental = this.config.get<boolean>("experimentalTruncation") || false
		return useExperimental ? new ExperimentalTruncationStrategy() : new StandardTruncationStrategy()
	}

	getStrategy(): ITruncationStrategy {
		return this.currentStrategy
	}
}
