import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { recordKycReviewInTx } from "../onboarding/review.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  notes?: string;
}

/**
 * @property approvedMerchantIds Only merchants that moved from under_review to approved.
 * Already-approved or rejected ids are skipped and not listed.
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

/** Approves the given merchants and audits it. */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  return withTransaction(pool, async (client) => {
    // B015: only merchants waiting for review are approved (a rejected or
    // already-approved merchant is skipped), and each one goes through the
    // same review function as a single approval, so every approval leaves a
    // merchant_kyc_reviews row saying who approved it.
    const eligible = await client.query<{ id: string }>(
      `SELECT id FROM merchants
        WHERE id = ANY($1::uuid[]) AND onboarding_status = 'under_review'
        ORDER BY id
        FOR UPDATE`,
      [input.merchantIds],
    );
    const reviewer = await client.query<{ email: string }>(`SELECT email FROM admin_users WHERE id = $1`, [
      input.adminUserId,
    ]);
    const approvedMerchantIds: string[] = [];
    for (const row of eligible.rows) {
      await recordKycReviewInTx(client, {
        merchantId: row.id,
        outcome: "approved",
        reviewerIdentifier: reviewer.rows[0]?.email ?? input.adminUserId,
        reviewerAdminUserId: input.adminUserId,
        notes: input.notes,
      });
      approvedMerchantIds.push(row.id);
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds };
  });
}
