import { Mastra } from "@mastra/core";
import { documentAgent } from "../../packages/agents/src/document-agent";
import { parsingAgent } from "../../packages/agents/src/parsing-agent";
import { embeddingAgent } from "../../packages/agents/src/embedding-agent";
import { classificationAgent } from "../../packages/agents/src/classification-agent";
import { retrievalAgent } from "../../packages/agents/src/retrieval-agent";
import { riskAgent } from "../../packages/agents/src/risk-agent";
import { benchmarkAgent } from "../../packages/agents/src/benchmark-agent";
import { rewriteAgent } from "../../packages/agents/src/rewrite-agent";
import { complianceAgent } from "../../packages/agents/src/compliance-agent";
import { evaluationAgent } from "../../packages/agents/src/evaluation-agent";
import { memoryAgent } from "../../packages/agents/src/memory-agent";
import { qaAgent } from "../../packages/agents/src/qa-agent";
import { reportingAgent } from "../../packages/agents/src/reporting-agent";
import { contractAnalysisWorkflow } from "../../packages/workflows/src/contract-analysis";

export const mastra = new Mastra({
  agents: {
    documentAgent,
    parsingAgent,
    embeddingAgent,
    classificationAgent,
    retrievalAgent,
    riskAgent,
    benchmarkAgent,
    rewriteAgent,
    complianceAgent,
    evaluationAgent,
    memoryAgent,
    qaAgent,
    reportingAgent,
  },
  workflows: {
    "contract-analysis": contractAnalysisWorkflow,
  },
});
export default mastra;
