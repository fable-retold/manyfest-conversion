# Manyfest Conversion

> Describe and execute JSON-to-PDF and JSON-to-XLSX form fills with mapping manyfests

- Build mapping manyfests from a single flat CSV of field mappings
- Fill fillable PDF forms via `pdftk` with XML-safe escaping
- Fill Excel workbooks via `exceljs` with fonts, borders, and themes preserved
- Expand source arrays into target cell ranges with `LineItems[].Price` <-> `'Sheet'!B3-14`
- Sidecar JSON reports capture every success, warning, and error
- CLI (`mfconv`) and Fable services share the same core

[GitHub](https://github.com/fable-retold/manyfest-conversion)
[Get Started](#manyfest-conversion)
