'use strict';

/**
 * wcisAdapterInterface.js — M22A WCIS adapter contract.
 *
 * All adapters MUST export an object (or instance) with these four
 * methods. wcisTransmissionService.getActiveAdapter() selects the
 * concrete adapter at runtime based on WCIS_ADAPTER env var.
 *
 * Contract:
 *
 *   async transmit(batch) → {
 *     vendor_reference: string,   // adapter-specific id
 *     submitted_at:     string,   // ISO 8601 timestamp
 *     estimated_ack_by: string,   // ISO 8601 timestamp
 *   }
 *
 *   async pollAcks(environment) → AckBatch[]
 *
 *     AckBatch = {
 *       transmission_id: string,
 *       ack_type:        '997' | 'AK1' | '824',
 *       received_at:     string,
 *       ack_raw:         string,
 *       per_transaction: Array<{
 *         transaction_id: string,
 *         result:         'accepted' | 'accepted_with_error' | 'rejected',
 *         jcn?:           string,           // FROI 00 accept returns JCN
 *         errors?:        Array<object>,
 *       }>
 *     }
 *
 *   async healthCheck() → { ok: boolean, detail: string }
 *
 *   name: string  // 'stub' | 'sftp' | 'vendor'
 *
 * Adapter lifecycle:
 *   - transmit is called by wcisTransmissionService.batchAndTransmit
 *     after batching wcis_transactions rows by (environment, mtc_family).
 *   - pollAcks is called by wcisAckPoller cron every 15 minutes.
 *   - healthCheck is called on startup and by admin UI.
 */

class AdapterNotImplemented extends Error {
  constructor(adapterName, milestone) {
    super(
      `${adapterName} adapter not implemented. ` +
      `M22A ships stubAdapter. Real ${adapterName} implementation ` +
      `is ${milestone}, gated on credentials / contracts.`,
    );
    this.name = 'AdapterNotImplemented';
    this.adapterName = adapterName;
    this.milestone = milestone;
  }
}

module.exports = { AdapterNotImplemented };
