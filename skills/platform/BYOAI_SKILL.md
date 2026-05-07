# SKILL: Bring Your Own AI (BYOAI) Router

## Overview
Route AI requests to any provider using the
user's own API key. Falls back to platform key.

## Supported Providers

| Provider | Base URL | Auth Header |
|---|---|---|
| Anthropic Claude | https://api.anthropic.com/v1 | x-api-key |
| OpenAI | https://api.openai.com/v1 | Authorization: Bearer |
| Groq | https://api.groq.com/openai/v1 | Authorization: Bearer |
| Perplexity | https://api.perplexity.ai | Authorization: Bearer |
| Google Gemini | https://generativelanguage.googleapis.com/v1beta | Authorization: Bearer |
| Ollama (local) | http://localhost:11434 | none |
| Custom | user-defined | Authorization: Bearer |

## Core Router Pattern

```typescript
export async function callAI(
  userId: number,
  messages: AIMessage[],
  systemPrompt: string
): Promise<AIResponse> {
  
  // 1. Get user's provider config
  const provider = await getAIProvider(userId)
  
  // 2. Decrypt API key
  const apiKey = provider 
    ? decrypt(provider.apiKey) 
    : process.env.ANTHROPIC_API_KEY
  
  // 3. Route to provider
  if (!provider || provider.provider === 'claude') {
    return callClaude(apiKey, messages, systemPrompt,
                      provider?.model)
  }
  
  // OpenAI-compatible providers
  return callOpenAICompat(
    apiKey,
    getBaseUrl(provider.provider, provider.apiUrl),
    provider.model,
    messages,
    systemPrompt
  )
}
```

## Claude Implementation
```typescript
async function callClaude(
  apiKey: string,
  messages: AIMessage[],
  system: string,
  model = 'claude-haiku-4-5'
): Promise<AIResponse> {
  const res = await fetch(
    'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system,
      messages
    })
  })
  const data = await res.json()
  return {
    content: data.content[0].text,
    provider: 'claude',
    model
  }
}
```

## OpenAI-Compatible Implementation
```typescript
async function callOpenAICompat(
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: AIMessage[],
  system: string
): Promise<AIResponse> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        ...messages
      ]
    })
  })
  const data = await res.json()
  return {
    content: data.choices[0].message.content,
    provider: baseUrl,
    model
  }
}
```

## Base URLs by Provider
```typescript
function getBaseUrl(provider: string, custom?: string) {
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    perplexity: 'https://api.perplexity.ai',
    ollama: custom || 'http://localhost:11434/v1',
    custom: custom || ''
  }
  return urls[provider] || urls.openai
}
```

## Recommended Models by Use Case
| Use Case | Recommended | Why |
|---|---|---|
| Brief/Debrief | claude-sonnet-4-5 | Best reasoning |
| QuantScript | claude-opus-4 | Best code gen |
| Quick analysis | claude-haiku-4-5 | Fast + cheap |
| Free users | groq/llama-3.3-70b | Free tier |

## Security
- Always encrypt API keys with AES-256-GCM
- Never log decrypted keys
- Validate provider enum before routing
- Rate limit per user per hour
