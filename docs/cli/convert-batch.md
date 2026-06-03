# convert-batch

Fill every applicable target form for every source JSON in one command. Routes sources to mappings by matching `ReportData.DocumentType` on the source against `SourceDocumentType` on the mapping manyfest.

**Aliases:** `cb`, `convert_batch`

## Usage

```shell
mfconv convert-batch -m <mappings-dir> -s <sources-dir> -t <templates-dir> -o <output-dir> [--source-root <address>]
```

## Options

| Option | Required | Description | Default |
|--------|----------|-------------|---------|
| `-m, --mappings <dirpath>` | Yes | Directory containing `.mapping.json` files. Non-mapping files are ignored. | -- |
| `-s, --source <dirpath>` | Yes | Directory containing source JSON payloads. Only `.json` files are considered. | -- |
| `-t, --templates <dirpath>` | Yes | Directory containing PDF and XLSX template files. Templates are looked up by `TargetFile` on each mapping. | -- |
| `-o, --output <dirpath>` | Yes | Directory to write filled artifacts into. Created if it does not exist. Sidecar reports go into `<output>/reports/`. | -- |
| `-r, --source-root <address>` | No | Override the `SourceRootAddress` on every mapping manyfest. | (use each mapping's stored value) |

## How it works

1. **Load mappings.** Walks `-m` and loads every file ending in `.mapping.json` as a live Manyfest instance. Groups them by `SourceDocumentType`.
2. **Walk sources.** Walks `-s` and reads every `.json` file.
3. **Route.** For each source JSON, extracts `ReportData.DocumentType`. Looks up the mappings for that document type.
4. **Resolve templates.** For each matching mapping, looks for `<templates-dir>/<TargetFile>`. If the CSV used the typo `.xslx` and the real file on disk is `.xlsx`, the filler automatically falls back to the correct extension.
5. **Fill and report.** Calls `PDFFormFiller.fillPDF` or `XLSXFormFiller.fillXLSX` for each (source, mapping) pair. Writes each filled artifact to `<output>/<sourceBase>__<sanitizedTargetName>` and each sidecar to `<output>/reports/<sourceBase>__<sanitizedTargetName>.report.json`.
6. **Aggregate.** Tracks total artifacts, warnings, and errors across the whole run. Exits `2` if any sidecar has a non-zero `ErrorCount`.

## Output layout

<!-- bespoke diagram: edit diagrams/output-layout.mmd or .hints.json, then: npx pict-renderer-graph build modules/utility/manyfest-conversion/docs/cli -->
![Output layout](diagrams/output-layout.svg)

Output filename convention: `<sourceBase>__<sanitizedTargetName>` where `sourceBase` is the source JSON filename without `.json` and `sanitizedTargetName` is the target filename with non-alphanumeric characters replaced by underscores.

## Exit codes

- `0` -- Clean run. No sidecar had `ErrorCount > 0`.
- `1` -- Usage error (missing flag, mappings directory not found, etc.).
- `2` -- One or more sidecars have errors. All partial fills and sidecars are still written.

Warnings alone never fail the exit.

## Routing rules

For a (source, mapping) pair to produce an artifact:

1. `source.ReportData.DocumentType === mapping.SourceDocumentType` (exact match)
2. `<templates-dir>/<mapping.TargetFile>` exists on disk (with `.xslx`->`.xlsx` fallback for typos)

If a source JSON's `DocumentType` does not match any loaded mapping, a warning is logged and the source is skipped:

```text
[MI - Rice Maximum Specific Gravity-IDDocument-2526272.json] has DocumentType [MI-Rice-Walbec] but no mapping manyfest targets it; skipping.
```

If a mapping's target template is missing, a warning is logged and that one mapping is skipped (other mappings for the same source still run):

```text
Template file [./templates/InventorySheet.xlsx] not found; skipping this output.
```

If a source JSON has no `ReportData.DocumentType` at all, a warning is logged and the source is skipped:

```text
[mystery.json] has no ReportData.DocumentType; skipping.
```

## Examples

### Basic batch run

```shell
mfconv convert-batch \
  -m ./translations \
  -s ./sources \
  -t ./templates \
  -o ./output
```

### Override the source root for every mapping

```shell
mfconv convert-batch \
  -m ./translations \
  -s ./sources \
  -t ./templates \
  -o ./output \
  --source-root "AppData.DocumentData.ReportData.FormData"
```

### Using the alias

```shell
mfconv cb -m ./translations -s ./sources -t ./templates -o ./output
```

### Per-run console output

```text
Loaded 14 mapping manyfest(s) across 13 document type(s).
[ok] PO-2026-0001.json -> AcquisitionOrder.pdf (6 success / 0 warn / 0 error)
[ok] PO-2026-0001.json -> InventorySheet.xlsx (143 success / 1 warn / 0 error)
[ok] PO-2026-0002.json -> AcquisitionOrder.pdf (6 success / 0 warn / 0 error)
[return-request-0077.json] has DocumentType [Bookstore-Return] but no mapping manyfest targets it; skipping.
Batch complete.  Artifacts: 3; total warnings: 1; total errors: 0.
```

## Aggregating sidecar stats across a batch

After a batch run you can aggregate the sidecars with a small script:

```shell
for f in ./output/reports/*.report.json; do
  jq -r '[.SourceFile, .TargetFile, .Stats.SuccessCount, .Stats.WarningCount, .Stats.ErrorCount] | @tsv' "$f"
done
```

Or in Node:

```javascript
const libFS = require('fs');
const libPath = require('path');

const dir = './output/reports';
let tmpArtifacts = 0, tmpSuccess = 0, tmpWarn = 0, tmpError = 0;
for (const tmpFile of libFS.readdirSync(dir).filter((n) => n.endsWith('.report.json')))
{
    const tmpReport = JSON.parse(libFS.readFileSync(libPath.join(dir, tmpFile), 'utf8'));
    tmpArtifacts++;
    tmpSuccess += tmpReport.Stats.SuccessCount;
    tmpWarn    += tmpReport.Stats.WarningCount;
    tmpError   += tmpReport.Stats.ErrorCount;
}
console.log(`${tmpArtifacts} artifacts, ${tmpSuccess} success / ${tmpWarn} warn / ${tmpError} error`);
```

## Common issues

### `has DocumentType [X] but no mapping manyfest targets it; skipping.`

The source JSON's `ReportData.DocumentType` doesn't match any mapping manyfest in the mappings directory. Either:

- Add a mapping for that document type to the CSV and rerun `build-mappings`, or
- The source JSON is for a different platform and shouldn't be in this batch

### `Template file [X] not found; skipping this output.`

The mapping manyfest's `TargetFile` doesn't exist in the templates directory. Check the filename exactly (case-sensitive on Linux/macOS). The `.xslx` -> `.xlsx` fallback only applies to that specific typo.

### Many warnings about "Source address did not resolve"

The mappings and sources are out of sync with respect to the source root. Override with `--source-root`, or rebuild the mappings with `mfconv build-mappings --source-root <right-one>`.

## See also

- [Overview](../overview.md#when-to-use-each-command)
- [build-mappings](build-mappings.md) -- build the mapping manyfest files this command consumes
- [fill-pdf](fill-pdf.md) -- single-file PDF counterpart
- [fill-xlsx](fill-xlsx.md) -- single-file XLSX counterpart
- [Sidecar Reports](../sidecar-reports.md)
