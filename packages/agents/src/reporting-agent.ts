/**
 * LexGuard AI — Reporting Agent (#13)
 * Final agent. Assembles the complete analysis report.
 * Output: structured JSON + board-ready summary.
 * Per PRD CRISPE Appendix A.6, LG-FUNC-010
 * FK readability > 60 for executive summary.
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import OpenAI from "openai";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { LLM_MODELS, RISK_SEVERITY } from "@lexguard/shared/constants";
import { recordLlmTokens } from "@lexguard/observability/metrics";
import { getEnv } from "@lexguard/shared/env";
import type { AnalysisReport, RiskSeverity } from "@lexguard/shared/schemas";
import { gpt4oMini } from "./models";

export interface ReportingAgentInput {
  contractId: string;
  orgId: string;
  contractTitle?: string;
  jurisdiction: string;
  riskResults: any[];
  benchmarkResults: any[];
  rewriteResults: any[];
  complianceResults: any[];
  enkryptConfidenceScores: Record<number, number>;  // clauseIndex → score
  hitlStatus: Record<number, "not_required" | "pending" | "approved" | "rejected">;
}

const generateExecutiveSummaryTool = createTool({
  id: "generate_executive_summary",
  description: "Generates a board-ready executive summary (max 150 words, FK > 60) from all agent outputs.",
  inputSchema: z.object({
    contractTitle: z.string(), jurisdiction: z.string(), orgId: z.string(),
    criticalCount: z.number(), moderateCount: z.number(), lowCount: z.number(),
    totalClauses: z.number(), complianceIssues: z.number(), hitlPending: z.number(),
  }),
  outputSchema: z.object({ summary: z.string(), promptHash: z.string(), inputTokens: z.number(), outputTokens: z.number() }),
  execute: async (input, context) => {
    const env = getEnv();
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const prompt = `ROLE: Senior Legal Analyst producing a board-ready contract intelligence report.
Write an executive summary for a ${input.contractTitle} (${input.jurisdiction}).
Max 150 words. Flesch-Kincaid readability score > 60 (plain English, short sentences, active voice).
Use labels: Critical / Moderate / Low.
Facts: ${input.totalClauses} clauses analysed, ${input.criticalCount} Critical risks, ${input.moderateCount} Moderate, ${input.lowCount} Low, ${input.complianceIssues} compliance issues, ${input.hitlPending} items pending human review.
Return JSON: {"summary":"..."}`;
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
    let summary = ""; let inputTokens = 0, outputTokens = 0;
    try {
      const response = await openai.chat.completions.create({
        model: LLM_MODELS.GPT4O_MINI, temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: prompt }, { role: "user", content: "Generate the executive summary." }],
      });
      inputTokens = response.usage?.prompt_tokens ?? 0;
      outputTokens = response.usage?.completion_tokens ?? 0;
      const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
      summary = parsed.summary ?? "Executive summary unavailable.";
      recordLlmTokens(input.orgId, LLM_MODELS.GPT4O_MINI, inputTokens, outputTokens);
    } catch {
      summary = `Contract analysis complete. Found ${input.criticalCount} Critical, ${input.moderateCount} Moderate, and ${input.lowCount} Low risk clauses across ${input.totalClauses} total clauses. ${input.complianceIssues} compliance issues detected. ${input.hitlPending} items require human review.`;
    }
    return { summary, promptHash, inputTokens, outputTokens };
  },
});

export const reportingAgent: Agent = new Agent({
  id: "reporting-agent",
  name: "reporting-agent",
  instructions: `You are the Reporting Agent — the final step in the LexGuard AI pipeline.
Use generate_executive_summary to produce a board-ready summary (150 words, FK > 60).
The report must include: executive summary, clause-by-clause breakdown, benchmark scores, rewrite suggestions, compliance flags, Enkrypt confidence scores, HITL status.
Do NOT include any finding with confidence < 0.70 without a HITL disclaimer.
Use Critical/Moderate/Low labels consistently throughout.`,
  model: gpt4oMini,
  tools: { generate_executive_summary: generateExecutiveSummaryTool },
});

export async function executeReportingAgent(input: ReportingAgentInput): Promise<AnalysisReport> {
  return withSpan(OTEL_SPAN_NAMES.AGENT_REPORTING_GENERATE, {
    "lexguard.org_id": input.orgId,
    "lexguard.contract_id": input.contractId,
    "lexguard.agent_id": "reporting-agent",
  }, async (span) => {
    // Tally risk counts across all clauses
    let criticalCount = 0, moderateCount = 0, lowCount = 0;
    for (const r of input.riskResults) {
      criticalCount += r.criticalCount ?? 0;
      moderateCount += r.moderateCount ?? 0;
      lowCount += r.lowCount ?? 0;
    }

    const totalClauses = input.riskResults.length;
    const complianceIssues = input.complianceResults.filter((c) => !c.isCompliant).length;
    const hitlPending = Object.values(input.hitlStatus).filter((s) => s === "pending").length;

    // Overall risk: Critical if any critical, else Moderate if any moderate, else Low
    const overallRisk: RiskSeverity =
      criticalCount > 0 ? RISK_SEVERITY.CRITICAL :
      moderateCount > 0 ? RISK_SEVERITY.MODERATE :
      RISK_SEVERITY.LOW;

    // Generate executive summary
    const summaryResult = (await generateExecutiveSummaryTool.execute?.({ contractTitle: input.contractTitle ?? "Contract", jurisdiction: input.jurisdiction, orgId: input.orgId, criticalCount, moderateCount, lowCount, totalClauses, complianceIssues, hitlPending }, {} as any)) as any || { summary: "Executive summary unavailable." };

    const reportId = uuidv4();

    // Assemble clause breakdown
    const clauseBreakdown = input.riskResults.map((r, i) => {
      const clauseIndex = r.riskReports?.[0]?.clauseIndex ?? i;
      const riskReport = r.riskReports?.[0];
      const benchmark = input.benchmarkResults.find((b) => b.clauseIndex === clauseIndex);
      const rewrite = input.rewriteResults.find((rw) => rw.clauseIndex === clauseIndex);
      const compliance = input.complianceResults.find((c) => c.clauseIndex === clauseIndex);
      const enkryptScore = input.enkryptConfidenceScores[clauseIndex] ?? 0;
      const hitlSt = input.hitlStatus[clauseIndex] ?? "not_required";

      return {
        clauseIndex,
        clauseType: riskReport?.clauseType ?? "unknown",
        clauseText: riskReport?.risks?.[0]?.triggeringLanguage ?? "",
        overallRisk: riskReport?.overallRisk ?? RISK_SEVERITY.LOW,
        risks: riskReport?.risks ?? [],
        rewrites: rewrite?.rewrites ?? [],
        benchmarkScore: benchmark?.percentileRank,
        benchmarkPercentile: benchmark?.percentileRank,
        complianceFlags: compliance?.findings?.map((f: any) => `${f.regulation} ${f.section}: ${f.offendingLanguage.slice(0, 60)}`) ?? [],
        enkryptConfidence: enkryptScore,
        hitlStatus: hitlSt,
      };
    });

    const jurisdictionFlags = input.complianceResults
      .filter((c) => !c.jurisdictionVerified)
      .map((c) => `Clause ${c.clauseIndex}: Jurisdiction unverified`);

    span.setAttribute("report.id", reportId);
    span.setAttribute("report.clause_count", totalClauses);
    span.setAttribute("report.critical_count", criticalCount);
    span.setAttribute("report.hitl_pending", hitlPending);

    return {
      reportId,
      contractId: input.contractId,
      orgId: input.orgId,
      generatedAt: new Date().toISOString(),
      executiveSummary: summaryResult.summary,
      clauseBreakdown,
      totalClauses,
      criticalCount,
      moderateCount,
      lowCount,
      overallRisk,
      jurisdictionFlags,
      exportFormats: ["json"],  // PDF export in Phase 4 with puppeteer/pdfkit
      traceId: "",
    };
  });
}
