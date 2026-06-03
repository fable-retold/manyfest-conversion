# Examples

Three non-construction examples walking through the full `build-mappings -> fill` pipeline. Each example ships with:

- A **source CSV** of field mappings
- A **sample source JSON** payload
- A built **mapping manyfest JSON** (the output of `build-mappings`)
- A walkthrough markdown showing the exact commands and expected outputs

All example assets live under [`docs/examples/data/`](data/).

## Available examples

### 1. [Bookstore Acquisition Order](bookstore-acquisition.md)

A fictional bookstore (Fable & Ink Books) issues purchase orders to a book distributor. The platform captures the order as JSON; the distributor expects an `AcquisitionOrder.pdf` form and an `InventorySheet.xlsx` workbook. This example demonstrates:

- A simple header-plus-line-items data shape
- Scalar fills for header fields
- Array broadcast for the line-item table into a range of XLSX cells (`LineItems[].Title -> 'Line Items'!B3-14`)
- Override of `SourceRootAddress` to handle a non-default envelope

### 2. [Library Catalog Inventory](library-catalog.md)

A public library tracks its catalog as JSON and needs a printable inventory sheet for annual audits. This example demonstrates:

- Multi-sheet XLSX target (separate sheets per book category)
- Nested source arrays (books by category, each with a list of copies)
- Per-field warn behavior when optional fields are missing

### 3. [IRS Form W-9](irs-w9.md)

The IRS Form W-9 (Request for Taxpayer Identification Number and Certification) is a public-domain US federal form that independent contractors fill out for each client. This example demonstrates:

- Fixed-field PDF form fill
- Mapping to standard government-form field names
- Handling checkbox rows with warn-and-skip in v1
- How you'd structure a real "contractor onboarding" pipeline

## Running an example

Each walkthrough follows the same three-step pattern:

```shell
# 1. Build the mapping manyfest from the example's CSV
mfconv build-mappings \
  -i ./docs/examples/data/<example>/mappings.csv \
  -o ./docs/examples/data/<example>/built-mappings

# 2. Fill the template from the example's source JSON
mfconv fill-pdf  \
  -m ./docs/examples/data/<example>/built-mappings/<form>.mapping.json \
  -s ./docs/examples/data/<example>/source.json \
  -t ./docs/examples/data/<example>/template.pdf \
  -o /tmp/filled-<example>.pdf

# 3. Inspect the sidecar
cat /tmp/filled-<example>.pdf.report.json
```

The templates referenced in the examples (`template.pdf`, `template.xlsx`) are **not** bundled with this module -- you'd need to supply your own fillable PDFs or Excel files with matching field names. The examples are designed to be usable without them too: the mapping manyfest JSON, the sample source JSON, and the expected sidecar report are all shown in full so you can trace the pipeline step-by-step without running anything.

## Example data layout

<!-- bespoke diagram: edit diagrams/example-data-layout.mmd or .hints.json, then: npx pict-renderer-graph build modules/utility/manyfest-conversion/docs/examples -->
![Example data layout](diagrams/example-data-layout.svg)
