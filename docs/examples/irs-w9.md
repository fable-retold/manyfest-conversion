# Example: IRS Form W-9

The **IRS Form W-9** (Request for Taxpayer Identification Number and Certification) is a public-domain US federal form that independent contractors fill out for each client. It is a good example of a fixed-field PDF form with a mix of:

- Simple text fields (name, address)
- Split text fields (SSN digits 1-3, 4-5, 6-9)
- A row of mutually exclusive checkbox fields (federal tax classification)
- Hand-signed fields (Part II signature and date)

This example demonstrates a **real-world PDF fill** pipeline for contractor onboarding, with `build-mappings` producing one mapping manyfest for the W-9, and `fill-pdf` filling it from a contractor record.

> **Note on the PDF template.** The IRS publishes `fw9.pdf` at <https://www.irs.gov/pub/irs-pdf/fw9.pdf> as a public-domain document. This module does not bundle the PDF itself -- you would download it directly from irs.gov at build time in a real pipeline. The mapping and source-JSON examples below are illustrative; the field names used match the fields in the IRS form as of the 2018 revision.

## Files

- [`data/irs-w9/mappings.csv`](data/irs-w9/mappings.csv) -- the CSV of field mappings (22 rows)
- [`data/irs-w9/source.json`](data/irs-w9/source.json) -- sample contractor payload (Ada Lovelace)
- [`data/irs-w9/built-mappings/fw9.pdf.mapping.json`](data/irs-w9/built-mappings/fw9.pdf.mapping.json) -- built mapping manyfest (20 mapped + 2 unmapped signature fields)

## The CSV

The W-9 form uses **hierarchical field names** that look like `topmostSubform[0].Page1[0].f1_01[0]`. These are the names used by the actual IRS PDF -- they come straight out of `pdftk fw9.pdf dump_data_fields`. The mapping CSV uses them verbatim:

```csv
Sort,PDF File,Field Type,Field Name,Form,Document Data Long Filler,Form Input Address,Form Input Address Long,Notes
1,fw9.pdf,Text,topmostSubform[0].Page1[0].f1_01[0],IRS-W9,W9Data.,LegalName,W9Data.LegalName,Line 1 - Name
2,fw9.pdf,Text,topmostSubform[0].Page1[0].f1_02[0],IRS-W9,W9Data.,BusinessName,W9Data.BusinessName,Line 2 - Business name
10,fw9.pdf,Button,topmostSubform[0].Page1[0].FederalClassification[0].c1_1[0],IRS-W9,W9Data.,Classification.Individual,W9Data.Classification.Individual,Line 3a - Individual
...
50,fw9.pdf,Text,topmostSubform[0].Page1[0].SSN[0].f1_11[0],IRS-W9,W9Data.,TaxIdentification.SSN1,W9Data.TaxIdentification.SSN1,Part I - SSN 1-3
51,fw9.pdf,Text,topmostSubform[0].Page1[0].SSN[0].f1_12[0],IRS-W9,W9Data.,TaxIdentification.SSN2,W9Data.TaxIdentification.SSN2,Part I - SSN 4-5
52,fw9.pdf,Text,topmostSubform[0].Page1[0].SSN[0].f1_13[0],IRS-W9,W9Data.,TaxIdentification.SSN3,W9Data.TaxIdentification.SSN3,Part I - SSN 6-9
60,fw9.pdf,Text,topmostSubform[0].Page1[0].f1_10[0],IRS-W9,W9Data.,,,,Part II - Signature (by hand)
61,fw9.pdf,Text,topmostSubform[0].Page1[0].Date[0],IRS-W9,W9Data.,,,,Part II - Date (by hand)
```

Three interesting patterns:

1. **Split SSN fields.** The W-9 splits the Social Security Number into three boxes (digits 1-3, 4-5, 6-9). The mapping represents this as three separate descriptors -- the source JSON carries `SSN1`, `SSN2`, `SSN3` as three strings.

2. **Mutually exclusive checkboxes.** Rows 10-15 map the Line 3a classification checkboxes. These are `Button`-typed descriptors -- the filler warns-and-skips them in v1. In practice you would render the W-9 to PDF through a different path, or hand-check the box on the printed form.

3. **Hand-signed fields.** Rows 60-61 have empty `Form Input Address` columns. They end up in `UnmappedTargetFields` on the mapping manyfest with the `Notes` from the CSV ("Part II - Signature (by hand)"). The filler ignores them at runtime.

## Build the mapping manyfest

```shell
mfconv build-mappings \
  -i docs/examples/data/irs-w9/mappings.csv \
  -o docs/examples/data/irs-w9/built-mappings \
  --source-root "ReportData.W9Data"
```

Console output:

```text
Parsed 22 CSV rows (20 accepted, 2 skipped).
Discovered 1 distinct target forms:
  -> [PDF] fw9.pdf (20 mapped, 2 unmapped)
Wrote 1 mapping manyfest file(s) to .../docs/examples/data/irs-w9/built-mappings
2 row(s) were skipped.  Details in .../docs/examples/data/irs-w9/built-mappings/build-report.json
```

20 descriptors are mapped. The 2 unmapped signature rows are on the manyfest's `UnmappedTargetFields` array.

## Source JSON

```json
{
  "ReportData":
  {
    "DocumentType": "IRS-W9",
    "W9Data":
    {
      "LegalName": "Ada Lovelace",
      "BusinessName": "",
      "Classification":
      {
        "Individual": "1",
        "CCorp": "",
        "SCorp": "",
        "Partnership": "",
        "Trust": "",
        "LLC": "",
        "LLCTaxClass": ""
      },
      "ExemptPayeeCode": "",
      "FATCAReportingCode": "",
      "Address":
      {
        "Street": "1 Analytical Engine Way",
        "CityStateZip": "Cambridge, MA 02139"
      },
      "RequesterNameAndAddress": "Charles Babbage Associates, LLC\n99 Difference Lane\nBoston, MA 02116",
      "AccountNumbers": "CONTRACTOR-2026-LOVELACE",
      "TaxIdentification":
      {
        "SSN1": "123",
        "SSN2": "45",
        "SSN3": "6789",
        "EIN1": "",
        "EIN2": ""
      }
    }
  }
}
```

A few things to note:

- `Classification.Individual` is `"1"` while all other Classification values are `""` -- this is how the contractor record represents "Ada is an individual, not a corporation".
- `TaxIdentification.SSN1`/`SSN2`/`SSN3` carry the three chunks of the SSN as separate strings.
- `BusinessName` is empty because Ada doesn't have a business name (she files as an individual).

## Fill the PDF

```shell
mfconv fill-pdf \
  -m docs/examples/data/irs-w9/built-mappings/fw9.pdf.mapping.json \
  -s docs/examples/data/irs-w9/source.json \
  -t ./templates/fw9.pdf \
  -o /tmp/lovelace-w9.pdf \
  --source-root "ReportData.W9Data"
```

## Expected sidecar stats

| Outcome | Count | Detail |
|---------|------:|--------|
| Text successes | 9 | LegalName, Address.Street, Address.CityStateZip, RequesterNameAndAddress, AccountNumbers, SSN1, SSN2, SSN3 -- plus the Line 3a LLCTaxClass text field |
| Text warnings (missing) | 5 | BusinessName (empty string is written), ExemptPayeeCode, FATCAReportingCode, EIN1, EIN2 (empty strings are written so counts may vary) |
| Button warnings (skipped) | 6 | All six Line 3a classification checkboxes |
| Errors | 0 | |

**Totals:** approximately **9 success / 11 warning / 0 error** depending on how the filler treats empty strings (empty strings are written as scalars, so they count as successes, not missing).

Refine the expectation by running the fill and inspecting `/tmp/lovelace-w9.pdf.report.json`.

## Checkbox handling

The sidecar warnings for the six classification rows all look like this:

```json
{
  "FieldName": "topmostSubform[0].Page1[0].FederalClassification[0].c1_1[0]",
  "SourceAddress": "ReportData.W9Data.Classification.Individual",
  "Message": "PDF checkbox/Button mappings are warn-and-skip in manyfest-conversion v1."
}
```

This is by design -- v1 leaves checkbox handling unfixed because a complete solution requires either:

1. A convention for mapping "which checkbox is selected" to a specific checkbox field, or
2. An explicit per-checkbox state map in the mapping manyfest

For now, the workflow is:

- The XFDF omits the checkbox fields entirely.
- When you open the filled PDF, the checkboxes are blank.
- The contractor hand-checks the appropriate box before signing.

Alternatively, if you control the target form, replace the checkbox row with a single Text field carrying the classification name -- then the fill works cleanly.

## Key takeaways

- **Public forms use hierarchical field names.** Don't fight the naming -- paste whatever `pdftk dump_data_fields` produces into the `Field Name` column verbatim.
- **Split fields map to separate descriptors.** The three-box SSN is three independent descriptors, each with its own source address.
- **Checkboxes are warn-and-skip in v1.** Plan your mapping CSV with explicit `Button` rows so the sidecar can surface them clearly.
- **Hand-signed fields belong in `UnmappedTargetFields`.** Leave the `Form Input Address` empty and use the `Notes` column to explain why -- the build report captures this for downstream reviewers.

## See also

- [Bookstore Acquisition Order](bookstore-acquisition.md) -- a simpler bookstore PO fill
- [Library Catalog Inventory](library-catalog.md) -- multi-sheet XLSX fill
- [fill-pdf CLI](../cli/fill-pdf.md)
- [Sidecar Reports](../sidecar-reports.md)
- IRS Form W-9 template: <https://www.irs.gov/pub/irs-pdf/fw9.pdf>
