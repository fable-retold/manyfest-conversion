# Manyfest Conversion

> **[Read the Manyfest-Conversion Documentation](https://fable-retold.github.io/manyfest-conversion/)** - interactive docs with the full API reference.

A suite of tools for describing how JSON platform payloads map onto fillable PDF forms and Excel spreadsheets, and for actually performing those fills from the command line or from your own code.

These tools are built to be usable from the command line, as Fable services inside your own applications, or both. This module presents these behaviors as a suite of externally usable Fable services and a command-line utility (`mfconv`) to drive them.

## What is a Mapping Manyfest?

A **mapping manyfest** is a standard [Manyfest](https://github.com/fable-retold/manyfest) schema whose descriptors describe, for one target form, which JSON source address feeds which PDF field or Excel cell. Descriptors carry the target metadata (field name, field type, cell range) as custom keys so a single file captures everything needed to fill that form from a platform payload.

```json
{
  "Scope": "Bookstore::AcquisitionOrder.pdf",
  "SourceRootAddress": "OrderData",
  "TargetFile": "AcquisitionOrder.pdf",
  "TargetFileType": "PDF",
  "SourceDocumentType": "Bookstore-Acquisition",
  "Descriptors":
  {
    "Header.PONumber":
    {
      "Name": "PO Number",
      "TargetFieldName": "po_number",
      "TargetFieldType": "Text"
    },
    "LineItems[].ISBN":
    {
      "Name": "ISBN column",
      "TargetFieldName": "'Line Items'!B3-14",
      "TargetFieldType": "Text"
    }
  }
}
```

One file per target form. The builder service reads a CSV of field mappings and emits one mapping manyfest per form. The filler services consume the mapping manyfests and fill PDFs (via `pdftk`) or Excel workbooks (via `exceljs`) from the source JSON.

## Installation

```shell
npm install manyfest-conversion
```

Or for CLI usage:

```shell
npx manyfest-conversion --help
```

`mfconv` is aliased to the same entry point.

### External requirement: `pdftk`

PDF filling shells out to the `pdftk` binary (or `pdftk-java`). Install it first:

```shell
brew install pdftk-java          # macOS
apt  install pdftk               # Debian / Ubuntu
```

XLSX filling has no external dependencies.

## Quick Start

### 1. (Optional) Extract a skeleton CSV from an existing fillable PDF

If you have a PDF with AcroForm fields and no mapping CSV yet, `extract-fields` sniffs every form field out of the PDF (via `pdftk dump_data_fields`) and writes a ready-to-edit CSV:

```shell
npx mfconv extract-fields -i ./templates/Washington-Drivers-Form.pdf -f WA-DriversLicense
```

This writes `./templates/Washington-Drivers-Form-ManyfestMapping.csv` with one row per form field. The `Form Input Address` column is empty on every row -- that's the next piece of work for the human author. Once the CSV is filled in, run `build-mappings` on it.

### 2. Build mapping manyfests from a CSV

```shell
npx mfconv build-mappings \
  -i ./mappings.csv \
  -o ./translations
```

The CSV describes one row per target field with columns for target file, target field name, source document type, and source JSON address. The command groups rows by target file and writes one `.mapping.json` per form into the output directory.

### 3. Fill a PDF from a source JSON

```shell
npx mfconv fill-pdf \
  -m ./translations/AcquisitionOrder.pdf.mapping.json \
  -s ./orders/PO-2026-0001.json \
  -t ./templates/AcquisitionOrder.pdf \
  -o ./filled/PO-2026-0001.pdf
```

Writes the filled PDF alongside a sidecar `PO-2026-0001.pdf.report.json` listing every success, warning, and error from the fill.

### 4. Fill an Excel workbook

```shell
npx mfconv fill-xlsx \
  -m ./translations/InventorySheet.xlsx.mapping.json \
  -s ./inventory/snapshot-2026-04-08.json \
  -t ./templates/InventorySheet.xlsx \
  -o ./filled/inventory-2026-04-08.xlsx
```

Formatting, fonts, borders, merged cells, and sheet themes are preserved on the round-trip.

### 5. Batch every source JSON against every matching mapping

```shell
npx mfconv convert-batch \
  -m ./translations \
  -s ./sources \
  -t ./templates \
  -o ./output
```

`convert-batch` loads every `.mapping.json` under the mappings directory, walks every `.json` under the sources directory, routes each source to the mapping whose `SourceDocumentType` matches its `ReportData.DocumentType`, and writes the filled artifacts plus sidecar reports into the output tree.

## Documentation

Comprehensive documentation is available in the [docs](./docs) folder:

| Guide | Description |
| ----- | ----------- |
| [Overview](docs/overview.md) | What the module does, what problems it solves, and when to use it. |
| [Quick Start](docs/quickstart.md) | Install, build a mapping manyfest, fill a form, read the sidecar. |
| [Architecture](docs/architecture.md) | System design and data flow with mermaid diagrams. |
| [Implementation Reference](docs/implementation-reference.md) | Service-level API reference for `MappingManyfestBuilder`, `PDFFormFiller`, `XLSXFormFiller`, `ConversionReport`. |
| [CLI Reference](docs/cli/overview.md) | Every `mfconv` command with options, examples, and exit codes. |
| [extract-fields](docs/cli/extract-fields.md) | Sniff every fillable field out of an existing PDF and emit a ready-to-edit mapping CSV. |
| [Mapping Manyfest Format](docs/mapping-manyfest-format.md) | The schema, custom descriptor keys, source root addresses, and array-broadcast syntax. |
| [Sidecar Reports](docs/sidecar-reports.md) | The success/warning/error report format written next to every filled artifact. |
| [Examples](docs/examples/README.md) | Runnable examples (bookstore acquisition, IRS W-9, library catalog). |

## How It Works

```text
 CSV of field mappings         Platform JSON payloads
         |                              |
         v                              v
   MappingManyfestBuilder        MappingManyfestBuilder
   (parse rows, group by form)   (load .mapping.json from disk)
         |                              |
         v                              v
   .mapping.json per form        Live Manyfest instance
         |                              |
         +----> PDFFormFiller <---------+----> XLSXFormFiller
                (build XFDF,                   (exceljs read/edit/write,
                 shell out to pdftk)            preserves formatting)
                      |                              |
                      v                              v
                 filled.pdf                    filled.xlsx
                      |                              |
                      +--> ConversionReport <--------+
                           (successes / warnings / errors)
                                     |
                                     v
                          filled.<ext>.report.json
```

Every stage is a Fable service. The CLI is a thin `pict-service-commandlineutility` wrapper that instantiates the services on a Fable instance and calls their public methods. You can skip the CLI entirely and drive the services directly in your own code -- see [Implementation Reference](docs/implementation-reference.md).

## Features

- **PDF -> Skeleton CSV** -- extract every fillable field from an existing PDF (via `pdftk dump_data_fields`) and emit a ready-to-edit mapping CSV so you never have to hand-enumerate form fields
- **CSV -> Mapping Manyfest** -- bootstrap one mapping manyfest per target form from a single flat CSV
- **Unmapped target tracking** -- CSV rows with no source address are still recorded as `UnmappedTargetFields` so authors can see what remains to be mapped
- **Configurable source root** -- every mapping carries a `SourceRootAddress` (e.g. `ReportData.FormData`) that's prepended at resolution time, so the same mapping can run against both platform-envelope and raw payloads
- **PDF form filling** -- via `pdftk` and XFDF, with XML-safe escaping and warn-and-skip for checkbox/Button fields
- **Excel filling with formatting preserved** -- backed by `exceljs`, so fonts, borders, merged cells, and themes survive the fill
- **Cell range expansion** -- target field names like `'Sheet'!O14-25` or `'Sheet'!A1:D5` expand to per-cell writes
- **Array broadcast** -- source addresses like `LineItems[].Price` pull a column out of an array of objects and pair element-by-element with a target cell range
- **Sidecar reports** -- every fill writes a companion JSON with every success, warning, and error so data-quality gaps are visible, not silent
- **Batch conversion** -- one command routes a folder of source JSONs to every matching mapping manyfest and writes everything into an output tree

## Running the Included Demo

The module ships with a set of sample forms, source JSONs, and a mapping CSV under `debug/dist/data/MDOT PDF Forms/`. A shell script runs the full pipeline against those samples:

```shell
./debug/dist/data/MDOT\ PDF\ Forms/run-demo.sh
```

The script builds mapping manyfests into `555-translations/` and fills the forms into `777-outputs/` (with sidecar reports under `777-outputs/reports/`).

## Related Packages

- [manyfest](https://github.com/fable-retold/manyfest) -- JSON object manifest for data description and parsing
- [fable](https://github.com/fable-retold/fable) -- Service dependency injection framework
- [pict-service-commandlineutility](https://github.com/fable-retold/pict-service-commandlineutility) -- CLI framework used by `mfconv`
- [meadow-integration](https://github.com/fable-retold/meadow-integration) -- Sibling data-integration toolkit for Meadow entities

## License

MIT
