# De-identification (anonymisation) — one page

Before a restricted extract leaves for another organisation, the people
behind the data must not be recoverable from it. Techniques and
terminology follow **ISO/IEC 20889** and **NIST IR 8053**; the anonymised
bar follows **GDPR Recital 26** (no singling out, no linkability, no
inference — WP29 Opinion 05/2014).

1. **Suppress** direct identifiers (names, IDs, addresses, contact
   details, full dates).
2. **Generalise** quasi-identifiers (bin dates and ages, coarsen
   geographies) and **pseudonymise** residual stable identifiers with
   `HMAC-SHA256(secret_salt, id)` — the salt never enters this
   repository and mapping tables are held separately.
3. **Guardrail**: every combination of quasi-identifiers occurs at least
   **k ≥ 5** times; suppress cells below k.
4. **Review** with a motivated-intruder pass by someone who did not build
   the extract, then record the transfer in `sharing/TRANSFER_LOG.csv`
   with the SHA-256 fingerprint of the shipped files.

Pseudonymised data is still personal data: if the extract does not meet
the anonymisation bar, it moves only under a signed data transfer
agreement.
