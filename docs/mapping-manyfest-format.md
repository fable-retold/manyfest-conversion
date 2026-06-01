# Mapping Manyfest Format

A **mapping manyfest** is a standard [Manyfest](https://fable-retold.github.io/manyfest/) schema with two additions:

1. **Top-level metadata** identifying the target form and source routing
2. **Custom descriptor keys** that tell the filler what to do with each resolved value

This document is the complete reference for the file format.

## Top-level shape

A descriptor can carry one or more **targets**. Most descriptors map a single source value to a single PDF field or Excel cell, but it is also common for the same source value to appear at multiple places on a form (header + footer, a value plus its summary cell, etc.) -- the `Targets` array represents that 1:N relationship.

```json
{
  "Scope": "Bookstore-Acquisition::AcquisitionOrder.pdf",
  "SourceRootAddress": "OrderData",
  "TargetFile": "AcquisitionOrder.pdf",
  "TargetFileType": "PDF",
  "SourceDocumentType": "Bookstore-Acquisition",
  "SourceRootFullPath": "AppData.DocumentData.OrderData.",
  "Descriptors":
  {
    "Header.PONumber":
    {
      "Name": "PO Number",
      "Hash": "AcquisitionOrder__po_number",
      "DataType": "String",
      "Targets":
      [
        {
          "TargetFieldName": "po_number",
          "TargetFieldType": "Text",
          "SourceSortOrder": 1,
          "Notes": null
        },
        {
          "TargetFieldName": "header_po_no",
          "TargetFieldType": "Text",
          "SourceSortOrder": 47,
          "Notes": null
        }
      ],
      "SourceAddressRaw": "Header.PONumber",
      "SourceAddressLong": "AppData.DocumentData.OrderData.Header.PONumber"
    }
  },
  "HashTranslations": {},
  "UnmappedTargetFields":
  [
    { "FieldName": "ship_to_signature", "FieldType": "Text", "Notes": "Not collected in the platform yet" }
  ]
}
```

## Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `Scope` | string | yes | Short identifier used by Manyfest for logging. Conventionally `<SourceDocumentType>::<TargetFile>`. |
| `SourceRootAddress` | string | yes | Prepended to every descriptor key at resolution time. See [Source root](#source-root) below. |
| `TargetFile` | string | yes | Filename of the target form (PDF or XLSX). Used by `convert-batch` to locate the template. |
| `TargetFileType` | string | yes | `'PDF'` or `'XLSX'`. Determines which filler service runs. |
| `SourceDocumentType` | string | yes | The `ReportData.DocumentType` value that a source JSON must carry for `convert-batch` to route it to this mapping. |
| `SourceRootFullPath` | string | no | The original "long filler" from the CSV, preserved for reference. Not used at runtime. |
| `Descriptors` | object | yes | Map of relative source address -> descriptor. One entry per mapped target field. |
| `HashTranslations` | object | no | Optional hash-translation table; see the Manyfest docs. Usually `{}`. |
| `UnmappedTargetFields` | array | no | Flat list of target fields that exist in the form but have no source mapping yet. Not used at runtime; exists to surface work for the CSV author. |

## Descriptor keys

Each entry under `Descriptors` is keyed by a **normalized source address** (relative to `SourceRootAddress`). The value is an object with the following keys.

### Standard Manyfest keys

| Key | Type | Description |
|-----|------|-------------|
| `Name` | string | Human-readable name for logging. Conventionally `<TargetFile>/<TargetFieldName>`. |
| `Hash` | string | Unique hash for this descriptor within the manyfest's scope. Conventionally `<form>__<field>`. |
| `DataType` | string | Manyfest data type (`String`, `Integer`, `Float`, etc.). The fillers stringify everything, so this is informational only in v1. |

### Custom keys used by the fillers

| Key | Type | Description |
|-----|------|-------------|
| `Targets` | array | One entry per target field this source value is written to. **Required** for the fillers (see "Targets array" below). |
| `SourceAddressRaw` | string | The pre-normalization source address from the CSV (e.g. `CAGTable[0]CAGB`). Preserved for reference. |
| `SourceAddressLong` | string | The "long form" source address from the CSV (e.g. `AppData.DocumentData.OrderData.Header.PONumber`). Preserved for reference. |

All custom keys are arbitrary JSON and are ignored by Manyfest itself -- only the fillers read them. You can add your own custom keys without breaking anything.

### Targets array

Each entry in `Targets[]` is a per-target spec:

| Key | Type | Description |
|-----|------|-------------|
| `TargetFieldName` | string | The target field identifier: a PDF form field name (`po_number`, `Text1`), or an Excel cell reference (`E5`, `'Line Items'!B3-14`). **Required.** |
| `TargetFieldType` | string | `'Text'` or `'Button'`. PDF Button fields are warn-and-skip in v1. XLSX ignores this field. |
| `SourceSortOrder` | number \| null | Original `Sort` column value from the CSV row that produced this target. Preserved for reference and for reconstructing CSV order. |
| `Notes` | string \| null | Free-form notes from the CSV's `Notes` column for this row. |

When the builder sees two CSV rows with the same source address but different target fields, it appends a second entry to `Targets[]` rather than skipping the row. When the same `(source, target)` pair appears twice (an actual CSV authoring duplicate), the second occurrence is skipped with a clear `Duplicate (source, target) pair` reason in the build report.

### Backward compatibility: legacy 1:1 descriptors

Mapping manyfest files written before the `Targets[]` array existed put the per-target keys directly on the descriptor:

```json
"Header.PONumber":
{
    "Name": "PO Number",
    "Hash": "AcquisitionOrder__po_number",
    "DataType": "String",
    "TargetFieldName": "po_number",
    "TargetFieldType": "Text",
    "SourceSortOrder": 1,
    "SourceAddressRaw": "Header.PONumber",
    "SourceAddressLong": "..."
}
```

The fillers continue to read this shape transparently -- they treat any descriptor without a `Targets[]` array as a single-target descriptor synthesized from the directly-attached `TargetFieldName` / `TargetFieldType` / `SourceSortOrder` / `Notes` keys. **No rebuild is required for previously-shipped mapping JSONs.** When you do rebuild a mapping CSV with `mfconv build-mappings`, the new file is written in the `Targets[]` shape.

## Source root

`SourceRootAddress` is prepended to each descriptor key at resolution time. This lets the same mapping manyfest run against different payload envelopes without rewriting every descriptor.

Given a mapping manyfest with:

```json
{
  "SourceRootAddress": "OrderData",
  "Descriptors":
  {
    "Header.PONumber": { "TargetFieldName": "po_number" }
  }
}
```

The filler resolves the source value at address `OrderData.Header.PONumber`.

If you move the same mapping manyfest to a platform where order data lives under `ReportData.OrderData`, you can override the root at fill time with `--source-root ReportData.OrderData` -- no file edit required.

The default source root produced by `build-mappings` is `ReportData.FormData` (the shape of on-disk exported platform payloads). Override with `--source-root` on `build-mappings` to bake a different value into the output files.

## Address normalization

The CSV convention `CAGTable[0]CAGB` (no dot between `]` and the next property) is **rewritten to** `CAGTable[0].CAGB` before being stored as a descriptor key. This is the only form that manyfest's address parser can resolve.

The original pre-normalization form is preserved on the descriptor as `SourceAddressRaw` so round-trips to and from the CSV don't lose information.

See [Source Address Syntax](source-address-syntax.md) for the complete grammar.

## Array-broadcast addresses

A source address can end in or contain `[]` to indicate "every element of this array":

```json
{
  "LineItems[].ISBN": { "TargetFieldName": "'Line Items'!A3-14" },
  "LineItems[].Title": { "TargetFieldName": "'Line Items'!B3-14" }
}
```

At fill time the XLSX filler detects `[]`, resolves the prefix (`LineItems`) as an array, and pairs each element's `.ISBN`/`.Title` with the corresponding cell in the target range. See [Source Address Syntax](source-address-syntax.md) for the exact semantics.

PDF fillers do not currently support array broadcast. PDFs use fixed field names per row (e.g. `line1_title`, `line2_title`), so explicit per-row descriptors are the normal pattern there.

## Unmapped target fields

When the CSV contains a row with an empty `Form Input Address`, the builder still creates the mapping manyfest (if this is the first row for that target file) and records the row's target field on the `UnmappedTargetFields` array:

```json
{
  "UnmappedTargetFields":
  [
    { "FieldName": "ship_to_signature", "FieldType": "Text", "Notes": "Not collected in the platform yet" },
    { "FieldName": "receiver_signature", "FieldType": "Text", "Notes": null }
  ]
}
```

These entries are ignored at fill time (they produce no output in the filled PDF or XLSX). They exist purely to surface which fields in the form template still need to be wired to a source address. Authors can inspect the array, decide whether the field needs a source or should stay empty, and update the CSV accordingly.

## File naming

`build-mappings` names the output file after the target filename, with non-alphanumeric characters replaced by underscores and `.mapping.json` appended:

| Target filename | Mapping filename |
|-----------------|------------------|
| `AcquisitionOrder.pdf` | `AcquisitionOrder.pdf.mapping.json` |
| `Acquisition Order.pdf` | `Acquisition_Order.pdf.mapping.json` |
| `HMA - Data Sheet - MI.xlsx` | `HMA_-_Data_Sheet_-_MI.xlsx.mapping.json` |
| `1903C - Daily Report Of Contractor's QC Tests.pdf` | `1903C_-_Daily_Report_Of_Contractor_s_QC_Tests.pdf.mapping.json` |

The suffix `.mapping.json` is important: `convert-batch` only reads files ending in `.mapping.json` from its mappings directory, ignoring any other JSON files that happen to be there.

## See also

- [Source Address Syntax](source-address-syntax.md) -- the complete address grammar including arrays, brackets, and broadcast
- [Target Cell and Range Syntax](target-cell-syntax.md) -- PDF field names and Excel cell/range references
- [Sidecar Reports](sidecar-reports.md) -- the per-fill outcome JSON
- [Implementation Reference](implementation-reference.md#mappingmanyfestbuilder) -- the service-level API for building and loading mapping manyfests
