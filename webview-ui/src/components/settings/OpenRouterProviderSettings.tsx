import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useState } from "react"
import styled from "styled-components"
import { ModelInfo, OpenRouterProviderPreferences } from "../../../../src/shared/api"
import { useExtensionState } from "../../context/ExtensionStateContext"

interface OpenRouterModelInfo extends ModelInfo {
	providers?: string[]
}

const SettingsContainer = styled.div`
	display: flex;
	flex-direction: column;
	gap: 16px;
	margin-top: 16px;
`

const SettingRow = styled.div`
	display: flex;
	flex-direction: column;
	gap: 8px;
`

const Label = styled.label`
	font-weight: 500;
`

interface OpenRouterProviderSettingsProps {
	modelId: string
	preferences: OpenRouterProviderPreferences
	onChange: (preferences: OpenRouterProviderPreferences) => void
}

const OpenRouterProviderSettings: React.FC<OpenRouterProviderSettingsProps> = ({ modelId, preferences, onChange }) => {
	const { apiConfiguration, openRouterModels } = useExtensionState()
	const [excludedProviders, setExcludedProviders] = useState<string>(preferences.excludeProviders?.join(", ") || "")

	const modelInfo = openRouterModels[modelId] as OpenRouterModelInfo
	const availableProviders = modelInfo?.providers || []

	const handlePreferredProviderChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const target = e.target as HTMLSelectElement
		onChange({
			...preferences,
			preferredProvider: target.value || undefined,
		})
	}

	const handleAllowFallbacksChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const target = e.target as HTMLInputElement
		onChange({
			...preferences,
			allowFallbacks: target.checked,
		})
	}

	const handleExcludedProvidersChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const target = e.target as HTMLInputElement
		const value = target.value
		setExcludedProviders(value)

		// Convert comma-separated string to array, trim whitespace
		const excludeProviders = value
			.split(",")
			.map((provider) => provider.trim())
			.filter((provider) => provider.length > 0)

		onChange({
			...preferences,
			excludeProviders: excludeProviders.length > 0 ? excludeProviders : undefined,
		})
	}

	return (
		<SettingsContainer>
			<SettingRow>
				<Label htmlFor="preferred-provider">Preferred Provider</Label>
				<VSCodeDropdown
					id="preferred-provider"
					value={preferences.preferredProvider || ""}
					onChange={handlePreferredProviderChange}>
					<VSCodeOption value="">No preference</VSCodeOption>
					{availableProviders.map((provider: string) => (
						<VSCodeOption key={provider} value={provider}>
							{provider}
						</VSCodeOption>
					))}
				</VSCodeDropdown>
			</SettingRow>

			<SettingRow>
				<VSCodeCheckbox
					id="allow-fallbacks"
					checked={preferences.allowFallbacks !== false}
					onChange={handleAllowFallbacksChange}>
					Allow fallbacks to other providers
				</VSCodeCheckbox>
			</SettingRow>

			<SettingRow>
				<Label htmlFor="exclude-providers">Excluded Providers</Label>
				<VSCodeTextField
					id="exclude-providers"
					placeholder="Enter provider names separated by commas"
					value={excludedProviders}
					onInput={handleExcludedProvidersChange}
				/>
			</SettingRow>
		</SettingsContainer>
	)
}

export default OpenRouterProviderSettings
