# OpenRouter Provider Preferences Implementation Plan

## Overview
Add support for specifying provider preferences in OpenRouter to control which providers handle requests, with UI integration in the Provider Settings tab.

## Backend Changes

### 1. API Types (src/shared/api.ts)
```typescript
interface OpenRouterProviderPreferences {
  preferredProvider?: string;     // Single preferred provider
  allowFallbacks?: boolean;       // Whether to allow fallbacks (default true)
  excludeProviders?: string[];    // Providers to ignore
}

interface ApiHandlerOptions {
  // ... existing options ...
  openRouterProviderPreferences?: OpenRouterProviderPreferences;
}
```

### 2. OpenRouter Handler (src/api/providers/openrouter.ts)
- Add provider preferences to chat completion options:
```typescript
const provider = this.options.openRouterProviderPreferences ? {
  order: this.options.openRouterProviderPreferences.preferredProvider ? 
    [this.options.openRouterProviderPreferences.preferredProvider] : undefined,
  allow_fallbacks: this.options.openRouterProviderPreferences.allowFallbacks,
  ignore: this.options.openRouterProviderPreferences.excludeProviders
} : undefined;

// Add to chat completion options
const stream = await this.client.chat.completions.create({
  // ... existing options ...
  provider: provider
});
```

### 3. Provider Information
Add function to fetch available providers for a model:
```typescript
async function getModelProviders(modelId: string): Promise<string[]> {
  const response = await axios.get('https://openrouter.ai/api/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  
  const modelInfo = response.data.data.find(
    (model: any) => model.id === modelId
  );
  return modelInfo?.providers || [];
}
```

## Frontend Changes

### 1. Provider Settings Component
Create new component for OpenRouter provider settings:
```typescript
interface OpenRouterProviderSettingsProps {
  modelId: string;  // Currently selected model
  preferences: OpenRouterProviderPreferences;
  onChange: (preferences: OpenRouterProviderPreferences) => void;
}
```

### 2. UI Elements
Add to Provider Settings tab when OpenRouter is selected:
- Dropdown/Combobox for preferredProvider
  - Populated with providers available for current model
  - Updates when model changes
- Checkbox for allowFallbacks
- Multi-select or list with removable items for excludeProviders

### 3. Settings Storage
Store preferences in VSCode settings:
```json
{
  "cline.openRouter.providerPreferences": {
    "preferredProvider": "anthropic",
    "allowFallbacks": true,
    "excludeProviders": ["azure"]
  }
}
```

## Implementation Steps

1. Backend Changes
   - Add OpenRouterProviderPreferences interface
   - Update ApiHandlerOptions
   - Modify OpenRouterHandler to use preferences
   - Add provider information fetching

2. Frontend Changes
   - Create OpenRouterProviderSettings component
   - Add UI elements to Provider Settings tab
   - Implement settings storage and retrieval
   - Add model-specific provider fetching

3. Testing
   - Test provider preferences are correctly sent to OpenRouter
   - Verify UI updates when model changes
   - Ensure settings persist between sessions
