import { createAzure } from "@ai-sdk/azure";

const azure = createAzure();

export const gpt4o: any = azure("gpt-4o");
export const gpt4oMini: any = azure("gpt-4o-mini");
