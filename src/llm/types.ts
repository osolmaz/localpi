export type ChatMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

export type CompletionOptions = {
  readonly baseUrl: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly timeoutMs: number;
};

export type CompletionResult = {
  readonly model: string;
  readonly content: string;
};
