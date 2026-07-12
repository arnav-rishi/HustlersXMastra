/**
 * Demo seed: inserts a COMPLETED contract analysis for legal.docx (a Land
 * Sale Agreement template) directly into Postgres, bypassing the live agent
 * pipeline entirely. Mirrors seed-demo-contract.ts's approach — the analysis
 * below reflects a genuine read of the actual document text.
 *
 * Usage: npx tsx prisma/seed-demo-contract-2.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEV_ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";
export const DEMO_CONTRACT_ID_2 = "22222222-2222-2222-2222-222222222222";

const clauses = [
  {
    clauseIndex: 0,
    clauseType: "payment_terms",
    clauseText:
      "The Parties mutually agree that the total sale consideration (\"Purchase Price\") for the Property shall be: INR ____________________________________________ (Rupees __________________________________________________________ Only.) Upon execution of this Agreement, the Buyer shall pay an Earnest Money Deposit of: INR ______________________________",
    riskLevel: "MODERATE" as const,
    riskScore: 55,
    risks: [
      {
        severity: "Moderate",
        description:
          "The Purchase Price, Earnest Money Deposit, and full instalment schedule are all left blank. This is not yet an executable agreement — every commercial term that actually binds the Parties still needs to be filled in and re-reviewed once populated.",
        triggeringLanguage: "INR ____________________________________________",
        financialExposure: "Entire deal value undefined",
        citation: "Section 3, Sale Consideration / Section 4.1, Earnest Money",
      },
    ],
    rewriteOptionA:
      "Insert the agreed Purchase Price, Earnest Money Deposit amount, and a complete instalment schedule with fixed dates before execution, and have counsel re-review the filled-in figures against the Buyer's financing timeline.",
  },
  {
    clauseIndex: 1,
    clauseType: "payment_terms",
    clauseText:
      "If any payment is delayed beyond the stipulated due date, the Seller may provide written notice requiring the Buyer to cure the default within ____ days. Failure to remedy the default within the prescribed period shall constitute a material breach of this Agreement and entitle the Seller to exercise the remedies available under this Agreement and applicable law.",
    riskLevel: "MODERATE" as const,
    riskScore: 40,
    risks: [
      {
        severity: "Moderate",
        description:
          "The cure period for a late payment is left blank. Without a fixed number of days, it's ambiguous how much time the Buyer actually has before a late payment escalates to a material breach.",
        triggeringLanguage: "cure the default within ____ days",
        financialExposure: "Ambiguous breach trigger timing",
        citation: "Section 4.4, Delay in Payment",
      },
    ],
    rewriteOptionA:
      "Failure to remedy the default within fifteen (15) days of written notice shall constitute a material breach of this Agreement.",
  },
  {
    clauseIndex: 2,
    clauseType: "indemnification",
    clauseText:
      "The Buyer shall indemnify and hold harmless the Seller against losses arising from: (a) breach of the Buyer's obligations under this Agreement; (b) unlawful acts committed by the Buyer after possession has been delivered; (c) non-payment of statutory charges allocated to the Buyer.",
    riskLevel: "LOW" as const,
    riskScore: 25,
    risks: [],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 3,
    clauseType: "indemnification",
    clauseText:
      "The Seller shall indemnify and hold harmless the Buyer against losses, liabilities, damages, or claims arising directly from: (a) a breach of the Seller's representations and warranties; (b) undisclosed encumbrances existing prior to the Completion Date; (c) fraud or willful misconduct by the Seller.",
    riskLevel: "LOW" as const,
    riskScore: 20,
    risks: [],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 4,
    clauseType: "termination",
    clauseText:
      "If the Buyer commits a material default, the Seller may, subject to applicable law: (a) terminate this Agreement by written notice; (b) retain the earnest money only to the extent permitted by law as compensation for actual loss; (c) seek specific performance, damages, or any other remedy available under law.",
    riskLevel: "LOW" as const,
    riskScore: 30,
    risks: [
      {
        severity: "Low",
        description:
          "Forfeiture of earnest money is capped by law (\"only to the extent permitted by law\"), which is Buyer-protective, but the Agreement doesn't state the earnest money amount itself (see Section 3/4.1), so the practical exposure can't be evaluated until that figure is filled in.",
        triggeringLanguage: "retain the earnest money only to the extent permitted by law",
        financialExposure: "Tied to unfilled Earnest Money figure",
        citation: "Section 17.1, Seller's Remedies",
      },
    ],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 5,
    clauseType: "dispute_resolution",
    clauseText:
      "The Parties shall first attempt to resolve any dispute arising out of or relating to this Agreement through good-faith negotiations. Where the Parties mutually agree in writing, unresolved disputes may be referred to arbitration in accordance with the applicable arbitration laws. The seat and venue of arbitration shall be mutually agreed upon. If arbitration is not applicable or available, the courts having territorial jurisdiction over the location of the Property shall have exclusive jurisdiction over disputes arising under this Agreement.",
    riskLevel: "MODERATE" as const,
    riskScore: 45,
    risks: [
      {
        severity: "Moderate",
        description:
          "Arbitration is only available if both Parties separately agree to it in writing at the time of the dispute — there's no standing arbitration commitment. In practice this means any dispute defaults to litigation in the Property's local courts unless both sides freshly consent to arbitrate, which a party acting in bad faith is unlikely to do.",
        triggeringLanguage: "Where the Parties mutually agree in writing, unresolved disputes may be referred to arbitration",
        financialExposure: "Litigation costs/delay if either party withholds arbitration consent",
        citation: "Section 22, Dispute Resolution",
      },
    ],
    rewriteOptionA:
      "Unresolved disputes shall be referred to binding arbitration under [applicable arbitration law], with the seat and venue at [city], without requiring further mutual consent at the time of the dispute.",
  },
  {
    clauseIndex: 6,
    clauseType: "compliance",
    clauseText:
      "This Agreement shall be governed by and construed in accordance with the laws applicable in the jurisdiction where the Property is situated.",
    riskLevel: "LOW" as const,
    riskScore: 22,
    risks: [
      {
        severity: "Low",
        description:
          "Governing law is defined by reference (\"where the Property is situated\") rather than naming a specific state/jurisdiction. This is workable once Schedule A (Property description) is filled in, but as a template it leaves the actual governing law undetermined.",
        triggeringLanguage: "the jurisdiction where the Property is situated",
        financialExposure: "N/A — clarity issue only",
        citation: "Section 21, Governing Law",
      },
    ],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 7,
    clauseType: "force_majeure",
    clauseText:
      "Neither Party shall be liable for delay or failure in performance resulting from events beyond its reasonable control, including but not limited to natural disasters, floods, earthquakes, fire, war, riots, acts of terrorism, epidemics, pandemics, governmental restrictions, court orders, or any other event that makes performance temporarily impossible.",
    riskLevel: "LOW" as const,
    riskScore: 15,
    risks: [],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 8,
    clauseType: "warranty",
    clauseText:
      "The Seller is the sole and absolute legal owner of the Property and possesses full legal authority, capacity, and power to enter into this Agreement and complete the sale contemplated herein. The Seller has good, valid, and marketable title to the Property and has not knowingly executed any document or undertaken any act that would materially impair the transfer of ownership to the Buyer.",
    riskLevel: "LOW" as const,
    riskScore: 18,
    risks: [],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 9,
    clauseType: "assignment",
    clauseText:
      "The Buyer shall not assign or transfer rights under this Agreement to any third party without the Seller's prior written consent, except where permitted by applicable law. Neither Party shall assign its rights or obligations under this Agreement without the prior written consent of the other Party, except where permitted by applicable law.",
    riskLevel: "LOW" as const,
    riskScore: 20,
    risks: [],
    rewriteOptionA: null,
  },
];

const criticalCount = clauses.filter((c) => c.riskLevel === "CRITICAL").length;
const moderateCount = clauses.filter((c) => c.riskLevel === "MODERATE").length;
const lowCount = clauses.filter((c) => c.riskLevel === "LOW").length;

const analysisJson = {
  executiveSummary:
    "This is a Land Sale Agreement template between a Seller and Buyer for an immovable property, and overall it is a reasonably balanced, standard-form document rather than a one-sided one — reps, warranties, indemnities, and force majeure protections run in both directions. The main issues are practical rather than adversarial: the Purchase Price, Earnest Money Deposit, and instalment schedule are all left blank, so the document isn't yet an executable agreement and needs those commercial terms filled in before signing. The payment default cure period is also blank, and the dispute resolution clause only allows arbitration if both parties separately consent in writing at the time of a dispute, meaning a bad-faith party could force litigation by simply withholding that consent. Governing law is defined by reference to the Property's location rather than named outright.",
  overallRisk: "Moderate",
  totalClauses: clauses.length,
  criticalCount,
  moderateCount,
  lowCount,
  jurisdictionFlags: [
    "Governing law is defined by reference to the Property's location rather than a named state — resolve once Schedule A is completed.",
  ],
  clauseBreakdown: clauses.map((c) => ({
    clauseIndex: c.clauseIndex,
    clauseType: c.clauseType,
    clauseText: c.clauseText,
    overallRisk: c.riskLevel.charAt(0) + c.riskLevel.slice(1).toLowerCase(),
    risks: c.risks,
    rewrites: c.rewriteOptionA ? [{ text: c.rewriteOptionA, version: 1 }] : [],
    benchmarkScore: c.riskScore,
    benchmarkPercentile: Math.min(95, c.riskScore + 5),
    complianceFlags: [],
    enkryptConfidence: 0.9,
    hitlStatus: "not_required",
  })),
};

async function main() {
  await prisma.contract.upsert({
    where: { id: DEMO_CONTRACT_ID_2 },
    update: {
      status: "COMPLETED",
      workflowStatus: "completed",
      workflowStep: "reporting",
      progressPct: 100,
      overallRisk: "MODERATE",
      analysisJson,
      completedAt: new Date(),
    },
    create: {
      id: DEMO_CONTRACT_ID_2,
      orgId: DEV_ORG_ID,
      uploadedBy: DEV_USER_ID,
      fileName: "legal.docx",
      fileSize: 18432,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      documentType: "DOCX",
      s3Key: "demo/legal.docx",
      jurisdiction: "India",
      status: "COMPLETED",
      workflowStatus: "completed",
      workflowStep: "reporting",
      progressPct: 100,
      pageCount: 6,
      partyNames: ["Seller", "Buyer"],
      contractTitle: "Land Sale Agreement",
      overallRisk: "MODERATE",
      analysisJson,
      completedAt: new Date(),
    },
  });

  await prisma.clause.deleteMany({ where: { contractId: DEMO_CONTRACT_ID_2 } });
  await prisma.clause.createMany({
    data: clauses.map((c) => ({
      contractId: DEMO_CONTRACT_ID_2,
      clauseIndex: c.clauseIndex,
      clauseType: c.clauseType,
      clauseText: c.clauseText,
      riskLevel: c.riskLevel,
      riskScore: c.riskScore,
      rewriteOptionA: c.rewriteOptionA,
    })),
  });

  console.log(`Seeded demo contract ${DEMO_CONTRACT_ID_2} with ${clauses.length} clauses (${criticalCount} critical, ${moderateCount} moderate, ${lowCount} low).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
