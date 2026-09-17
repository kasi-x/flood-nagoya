# Data Transfer Agreement (template)

> Template for controlled sharing of ANONYMIZED EXTRACT or (exceptionally)
> RESTRICTED data with an external party. Fill in the fields, have it
> signed by both parties, archive it, and only then ship the data and log
> the transfer in `TRANSFER_LOG.csv`.

## 1. Parties

- **Discloser**: kasi-x — project `flood-nagoya`
  (contact: 149961262+kasi-x@users.noreply.github.com)
- **Recipient**: TODO organisation, contact, role

## 2. Purpose and scope

The Discloser provides the dataset(s) described below solely for:

> TODO — one paragraph: the agreed analysis purpose.

| Dataset | SHA-256 fingerprint | De-identification level |
| --- | --- | --- |
| TODO `extract/…` | TODO | anonymized / pseudonymised (restricted) |

## 3. Conditions of use

- The dataset is shared under the project's pseudonymisation protocol
  (`DEIDENTIFICATION.md`, ISO 25237) with GA4GH DUO use conditions
  (`DUO.md`).
- The Recipient uses the data only for the purpose above (DUO codes: TODO).
- **No re-identification**: the Recipient must not attempt to identify
  individuals, and must not link the data with other datasets in a way
  that could enable re-identification.
- **No redistribution**: the data may not be copied, sold, or shared with
  third parties, in whole or in part, without prior written permission.
- Access is limited to named authorised personnel:
  TODO names / teams.

## 4. Security

The Recipient stores the data with access control, encrypts it at rest
and in transit, and reports any suspected breach to the Discloser within
TODO hours/days.

## 5. Retention and destruction

The Recipient destroys all copies (including backups and derivatives)
within TODO days of the earlier of (a) purpose completion or (b) a written
request by the Discloser, and confirms destruction in writing.

## 6. Signatures

| | Discloser | Recipient |
| --- | --- | --- |
| Name | TODO | TODO |
| Date | TODO | TODO |
| Signature | TODO | TODO |

Agreement reference for the transfer log: `DTA-TODO`
