const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libExcelJS = require('exceljs');

const libFS = require('fs');

/**
 * XLSXFormFiller
 *
 * Fills an Excel workbook from a platform JSON payload using a mapping
 * manyfest.  Backed by exceljs (not the SheetJS community edition) so
 * fonts, borders, fills, conditional formats, drawings, and other workbook
 * theming survive the round-trip.
 *
 * Each descriptor's TargetFieldName is a cell reference, optionally with a
 * sheet qualifier.  Three styles are supported:
 *
 *   E5                              - bare cell, default sheet
 *   'FIELD DATA SHEET'!E5           - quoted sheet name
 *   FIELD DATA SHEET!E5             - unquoted sheet name (with spaces)
 *
 * Cell ranges are supported in both the SheetJS-style and the hyphenated
 * shorthand the Walbec-MDOT CSV uses:
 *
 *   'FIELD DATA SHEET'!O14:O25      - colon range, single column
 *   'FIELD DATA SHEET'!A1:D5        - colon range, rectangular block
 *   'FIELD DATA SHEET'!O14-25       - hyphen shorthand: O14 .. O25
 *
 * Source addresses may use Manyfest's normal dot/bracket syntax for scalar
 * values, or the empty-bracket array-broadcast convention to pull a column
 * out of an array of objects:
 *
 *   ExtractionGradationTable[].JMF
 *
 * resolves to the JMF field of every element in the ExtractionGradationTable
 * array.  When paired with a target cell range the values are written into
 * the range cell-by-cell (truncated or warned if the sizes do not match).
 */
class XLSXFormFiller extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'XLSXFormFiller';
	}

	/**
	 * Parse a target cell reference into { sheetName, cellAddresses[] }.
	 * Always returns an array of A1 addresses (length 1 for single cells).
	 */
	parseTargetCellSpec(pRawRef)
	{
		if (!pRawRef || typeof(pRawRef) !== 'string')
		{
			return { sheetName: null, cellAddresses: [] };
		}

		const tmpTrimmed = pRawRef.trim();
		const tmpBangIndex = tmpTrimmed.lastIndexOf('!');

		let tmpSheet = null;
		let tmpCellPart = tmpTrimmed;
		if (tmpBangIndex >= 0)
		{
			tmpSheet = tmpTrimmed.substring(0, tmpBangIndex).trim();
			tmpCellPart = tmpTrimmed.substring(tmpBangIndex + 1).trim();

			// Strip any leading/trailing single quotes (the sample CSV mixes
			// `'FIELD DATA SHEET'!E5` and `FIELD DATA SHEET'!E5`).
			while (tmpSheet.length > 0 && tmpSheet.charAt(0) === "'")
			{
				tmpSheet = tmpSheet.substring(1);
			}
			while (tmpSheet.length > 0 && tmpSheet.charAt(tmpSheet.length - 1) === "'")
			{
				tmpSheet = tmpSheet.substring(0, tmpSheet.length - 1);
			}
		}

		const tmpAddresses = this.expandCellRange(tmpCellPart);
		return { sheetName: tmpSheet, cellAddresses: tmpAddresses };
	}

	/**
	 * Expand a cell-or-range string into a flat A1-style address list.
	 *
	 *   'E5'      -> ['E5']
	 *   'O14-25'  -> ['O14','O15',...,'O25']     (hyphen shorthand: same column)
	 *   'O14:O25' -> ['O14','O15',...,'O25']     (colon range, single column)
	 *   'A1:D5'   -> ['A1','B1','C1','D1','A2',...] (colon range, row-major)
	 */
	expandCellRange(pRangeString)
	{
		if (!pRangeString || typeof(pRangeString) !== 'string')
		{
			return [];
		}
		const tmpRange = pRangeString.trim();

		// Hyphen shorthand: <Col><StartRow>-<EndRow>  e.g. O14-25
		const tmpHyphenMatch = tmpRange.match(/^([A-Z]+)(\d+)-(\d+)$/);
		if (tmpHyphenMatch)
		{
			const tmpCol = tmpHyphenMatch[1];
			const tmpStart = parseInt(tmpHyphenMatch[2], 10);
			const tmpEnd = parseInt(tmpHyphenMatch[3], 10);
			const tmpResult = [];
			if (tmpStart <= tmpEnd)
			{
				for (let i = tmpStart; i <= tmpEnd; i++)
				{
					tmpResult.push(`${tmpCol}${i}`);
				}
			}
			return tmpResult;
		}

		// Colon range: <Col1><Row1>:<Col2><Row2>  e.g. A1:D5
		const tmpColonMatch = tmpRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
		if (tmpColonMatch)
		{
			const tmpStartCol = this.columnLettersToNumber(tmpColonMatch[1]);
			const tmpStartRow = parseInt(tmpColonMatch[2], 10);
			const tmpEndCol = this.columnLettersToNumber(tmpColonMatch[3]);
			const tmpEndRow = parseInt(tmpColonMatch[4], 10);
			const tmpResult = [];
			for (let r = tmpStartRow; r <= tmpEndRow; r++)
			{
				for (let c = tmpStartCol; c <= tmpEndCol; c++)
				{
					tmpResult.push(`${this.columnNumberToLetters(c)}${r}`);
				}
			}
			return tmpResult;
		}

		// Single cell: <Col><Row>
		const tmpCellMatch = tmpRange.match(/^([A-Z]+)(\d+)$/);
		if (tmpCellMatch)
		{
			return [tmpRange];
		}

		// Unrecognized — return as-is so the caller can surface a clear error.
		return [tmpRange];
	}

	/**
	 * Convert "A" -> 1, "Z" -> 26, "AA" -> 27, etc.
	 */
	columnLettersToNumber(pLetters)
	{
		let tmpNum = 0;
		for (let i = 0; i < pLetters.length; i++)
		{
			tmpNum = tmpNum * 26 + (pLetters.charCodeAt(i) - 64);
		}
		return tmpNum;
	}

	/**
	 * Convert 1 -> "A", 27 -> "AA", etc.
	 */
	columnNumberToLetters(pNumber)
	{
		let tmpResult = '';
		let tmpN = pNumber;
		while (tmpN > 0)
		{
			const tmpRem = (tmpN - 1) % 26;
			tmpResult = String.fromCharCode(65 + tmpRem) + tmpResult;
			tmpN = Math.floor((tmpN - 1) / 26);
		}
		return tmpResult;
	}

	/**
	 * Resolve a (possibly array-broadcast) source address against the source
	 * data using the mapping manyfest.  Returns an object describing the
	 * outcome:
	 *
	 *   { kind: 'scalar', value }
	 *   { kind: 'array',  values: [...] }   (the prefix[].suffix expansion)
	 *   { kind: 'missing' }                 (resolved to null/undefined)
	 *   { kind: 'error', message }          (could not resolve)
	 */
	resolveSourceValue(pMappingManyfest, pSourceData, pFullAddress)
	{
		if (!pFullAddress || typeof(pFullAddress) !== 'string')
		{
			return { kind: 'error', message: 'Empty source address.' };
		}

		const tmpEmptyBracketIndex = pFullAddress.indexOf('[]');
		if (tmpEmptyBracketIndex < 0)
		{
			let tmpValue;
			try
			{
				tmpValue = pMappingManyfest.getValueAtAddress(pSourceData, pFullAddress);
			}
			catch (pError)
			{
				return { kind: 'error', message: `Error resolving source address: ${pError.message}` };
			}
			if (typeof(tmpValue) === 'undefined' || tmpValue === null)
			{
				return { kind: 'missing' };
			}
			if (typeof(tmpValue) === 'object')
			{
				return { kind: 'error', message: 'Source address resolved to an object/array, not a scalar.' };
			}
			return { kind: 'scalar', value: tmpValue };
		}

		// Array-broadcast: prefix[].suffix
		const tmpPrefix = pFullAddress.substring(0, tmpEmptyBracketIndex);
		// Skip the "[]" itself, then the optional leading "." in the suffix.
		let tmpSuffix = pFullAddress.substring(tmpEmptyBracketIndex + 2);
		if (tmpSuffix.startsWith('.'))
		{
			tmpSuffix = tmpSuffix.substring(1);
		}

		let tmpArray;
		try
		{
			tmpArray = pMappingManyfest.getValueAtAddress(pSourceData, tmpPrefix);
		}
		catch (pError)
		{
			return { kind: 'error', message: `Error resolving array prefix [${tmpPrefix}]: ${pError.message}` };
		}
		if (!Array.isArray(tmpArray))
		{
			return { kind: 'error', message: `Source array prefix [${tmpPrefix}] did not resolve to an array.` };
		}

		const tmpValues = [];
		for (let i = 0; i < tmpArray.length; i++)
		{
			const tmpElementAddress = tmpSuffix
				? `${tmpPrefix}[${i}].${tmpSuffix}`
				: `${tmpPrefix}[${i}]`;
			let tmpElementValue;
			try
			{
				tmpElementValue = pMappingManyfest.getValueAtAddress(pSourceData, tmpElementAddress);
			}
			catch (pError)
			{
				tmpValues.push({ ok: false, message: `Error at index ${i}: ${pError.message}` });
				continue;
			}
			if (typeof(tmpElementValue) === 'undefined' || tmpElementValue === null)
			{
				tmpValues.push({ ok: false, message: `Element at index ${i} is missing or null.` });
			}
			else if (typeof(tmpElementValue) === 'object')
			{
				tmpValues.push({ ok: false, message: `Element at index ${i} is an object/array, not a scalar.` });
			}
			else
			{
				tmpValues.push({ ok: true, value: tmpElementValue });
			}
		}
		return { kind: 'array', values: tmpValues };
	}

	/**
	 * Normalize a descriptor (old or new shape) to a flat array of target
	 * specs.  Mirrors MappingManyfestBuilder.normalizeDescriptorTargets so
	 * the XLSX filler stays self-sufficient even when the builder service
	 * is not registered on the fable.
	 *
	 * @param {object} pDescriptor
	 * @returns {Array<object>}
	 */
	normalizeDescriptorTargets(pDescriptor)
	{
		if (!pDescriptor || typeof(pDescriptor) !== 'object')
		{
			return [];
		}
		if (Array.isArray(pDescriptor.Targets) && pDescriptor.Targets.length > 0)
		{
			return pDescriptor.Targets;
		}
		if (pDescriptor.TargetFieldName)
		{
			return [
				{
					TargetFieldName: pDescriptor.TargetFieldName,
					TargetFieldType: pDescriptor.TargetFieldType || 'Text',
					SourceSortOrder: (typeof(pDescriptor.SourceSortOrder) === 'undefined') ? null : pDescriptor.SourceSortOrder,
					Notes: pDescriptor.Notes || null
				}
			];
		}
		return [];
	}

	/**
	 * Coerce a resolved source value to the JS type exceljs should store,
	 * based on the descriptor's TargetFieldType.
	 *
	 * `Number` targets are written as real numeric cells so downstream Excel
	 * formulas (SUM/AVERAGE/arithmetic) treat them as values.  The platform
	 * payloads stringify everything, so a numeric value arrives here as a
	 * string like "304"; storing that verbatim lands it in the sharedStrings
	 * table as text, which Excel flags "number stored as text" and which
	 * breaks any formula that references the cell.  (Google Sheets silently
	 * coerces such text on load, which masked this for a long time.)
	 *
	 * Everything else keeps the historical string behaviour.  A `Number`
	 * target whose value is blank stays blank (rather than becoming 0), and
	 * one whose value is not actually numeric falls back to text so we never
	 * write NaN or silently drop the human-visible content.
	 */
	coerceCellValue(pValue, pTargetFieldType)
	{
		if (String(pTargetFieldType || 'Text') !== 'Number')
		{
			return String(pValue);
		}

		if (pValue === null || typeof(pValue) === 'undefined')
		{
			return null;
		}
		if (typeof(pValue) === 'number')
		{
			return Number.isFinite(pValue) ? pValue : String(pValue);
		}

		const tmpTrimmed = String(pValue).trim();
		if (tmpTrimmed === '')
		{
			// Blank source for a numeric field — leave the cell empty, don't write 0.
			return null;
		}
		const tmpNumber = Number(tmpTrimmed);
		if (Number.isFinite(tmpNumber))
		{
			return tmpNumber;
		}
		// Declared Number but the value isn't numeric — keep the text so the
		// human-visible content survives rather than writing NaN.
		return String(pValue);
	}

	/**
	 * Write a single value into a cell on an exceljs worksheet, preserving
	 * the cell's existing style.  Setting cell.value on an exceljs Cell
	 * leaves the style metadata intact, which is the whole point of using
	 * exceljs over the SheetJS community edition for this filler.
	 *
	 * pTargetFieldType selects the stored cell type — see coerceCellValue.
	 */
	writeCellValue(pWorksheet, pCellAddress, pValue, pTargetFieldType)
	{
		const tmpCell = pWorksheet.getCell(pCellAddress);
		tmpCell.value = this.coerceCellValue(pValue, pTargetFieldType);
	}

	/**
	 * End-to-end fill.  Returns a Promise that resolves to the (annotated)
	 * report.  exceljs's read/write are async so the whole pipeline is async.
	 */
	async fillXLSX(pMappingManyfest, pSourceData, pTemplateXLSXPath, pOutputXLSXPath, pReport, pConversionReportService)
	{
		if (!libFS.existsSync(pTemplateXLSXPath))
		{
			pConversionReportService.logError(pReport, null, null, `Template XLSX does not exist: ${pTemplateXLSXPath}`);
			pConversionReportService.finalize(pReport);
			throw new Error(`Template XLSX does not exist: ${pTemplateXLSXPath}`);
		}

		const tmpWorkbook = new libExcelJS.Workbook();
		await tmpWorkbook.xlsx.readFile(pTemplateXLSXPath);

		// Determine a default sheet name (the first worksheet).
		let tmpDefaultSheetName = null;
		if (tmpWorkbook.worksheets.length > 0)
		{
			tmpDefaultSheetName = tmpWorkbook.worksheets[0].name;
		}

		const tmpManifestData = pMappingManyfest.manifest || {};
		const tmpSourceRoot = tmpManifestData.SourceRootAddress || '';

		const tmpDescriptorAddresses = pMappingManyfest.elementAddresses || [];
		for (let i = 0; i < tmpDescriptorAddresses.length; i++)
		{
			const tmpRelativeAddress = tmpDescriptorAddresses[i];
			const tmpDescriptor = pMappingManyfest.elementDescriptors[tmpRelativeAddress];
			if (!tmpDescriptor)
			{
				continue;
			}

			const tmpTargets = this.normalizeDescriptorTargets(tmpDescriptor);
			if (tmpTargets.length === 0)
			{
				continue;
			}

			const tmpFullAddress = this.joinAddress(tmpSourceRoot, tmpRelativeAddress);

			// Resolve the source value ONCE per descriptor.  Every target on
			// this descriptor consumes the same value (or array of values).
			const tmpResolved = this.resolveSourceValue(pMappingManyfest, pSourceData, tmpFullAddress);

			for (let t = 0; t < tmpTargets.length; t++)
			{
				const tmpTarget = tmpTargets[t] || {};
				const tmpTargetFieldRaw = tmpTarget.TargetFieldName || '';

				const tmpTargetSpec = this.parseTargetCellSpec(tmpTargetFieldRaw);
				const tmpSheetName = tmpTargetSpec.sheetName || tmpDefaultSheetName;
				if (!tmpTargetSpec.cellAddresses || tmpTargetSpec.cellAddresses.length === 0)
				{
					pConversionReportService.logError(
						pReport,
						tmpTargetFieldRaw,
						tmpFullAddress,
						`Could not parse cell reference [${tmpTargetFieldRaw}]`);
					continue;
				}

				const tmpWorksheet = tmpWorkbook.getWorksheet(tmpSheetName);
				if (!tmpWorksheet)
				{
					pConversionReportService.logError(
						pReport,
						tmpTargetFieldRaw,
						tmpFullAddress,
						`Sheet [${tmpSheetName}] not found in workbook.`);
					continue;
				}

				if (tmpResolved.kind === 'error')
				{
					pConversionReportService.logError(pReport, tmpTargetFieldRaw, tmpFullAddress, tmpResolved.message);
					continue;
				}

				if (tmpResolved.kind === 'missing')
				{
					pConversionReportService.logWarning(
						pReport,
						tmpTargetFieldRaw,
						tmpFullAddress,
						'Source address did not resolve to a value in the payload.');
					continue;
				}

				if (tmpResolved.kind === 'scalar')
				{
					if (tmpTargetSpec.cellAddresses.length === 1)
					{
						try
						{
							this.writeCellValue(tmpWorksheet, tmpTargetSpec.cellAddresses[0], tmpResolved.value, tmpTarget.TargetFieldType);
							pConversionReportService.logSuccess(pReport, tmpTargetFieldRaw, tmpFullAddress, tmpResolved.value);
						}
						catch (pError)
						{
							pConversionReportService.logError(
								pReport,
								tmpTargetFieldRaw,
								tmpFullAddress,
								`Error writing cell: ${pError.message}`);
						}
					}
					else
					{
						pConversionReportService.logWarning(
							pReport,
							tmpTargetFieldRaw,
							tmpFullAddress,
							`Scalar source paired with a ${tmpTargetSpec.cellAddresses.length}-cell range; refusing to broadcast a single value.`);
					}
					continue;
				}

				// Array source.  Pair element-by-element with the target cells.
				const tmpArrayValues = tmpResolved.values;
				const tmpRangeSize = tmpTargetSpec.cellAddresses.length;
				const tmpPaired = Math.min(tmpArrayValues.length, tmpRangeSize);

				for (let j = 0; j < tmpPaired; j++)
				{
					const tmpElement = tmpArrayValues[j];
					const tmpCellAddress = tmpTargetSpec.cellAddresses[j];
					if (!tmpElement.ok)
					{
						pConversionReportService.logWarning(
							pReport,
							`${tmpTargetFieldRaw} -> ${tmpCellAddress}`,
							`${tmpFullAddress} [${j}]`,
							tmpElement.message);
						continue;
					}
					try
					{
						this.writeCellValue(tmpWorksheet, tmpCellAddress, tmpElement.value, tmpTarget.TargetFieldType);
						pConversionReportService.logSuccess(
							pReport,
							`${tmpTargetFieldRaw} -> ${tmpCellAddress}`,
							`${tmpFullAddress} [${j}]`,
							tmpElement.value);
					}
					catch (pError)
					{
						pConversionReportService.logError(
							pReport,
							`${tmpTargetFieldRaw} -> ${tmpCellAddress}`,
							`${tmpFullAddress} [${j}]`,
							`Error writing cell: ${pError.message}`);
					}
				}

				if (tmpArrayValues.length > tmpRangeSize)
				{
					pConversionReportService.logWarning(
						pReport,
						tmpTargetFieldRaw,
						tmpFullAddress,
						`Source array has ${tmpArrayValues.length} elements but target range has ${tmpRangeSize} cells; truncated ${tmpArrayValues.length - tmpRangeSize} value(s).`);
				}
				else if (tmpArrayValues.length < tmpRangeSize)
				{
					pConversionReportService.logWarning(
						pReport,
						tmpTargetFieldRaw,
						tmpFullAddress,
						`Source array has ${tmpArrayValues.length} elements but target range has ${tmpRangeSize} cells; ${tmpRangeSize - tmpArrayValues.length} cell(s) left untouched.`);
				}
			}
		}

		await tmpWorkbook.xlsx.writeFile(pOutputXLSXPath);
		pConversionReportService.finalize(pReport);
		return pReport;
	}

	joinAddress(pSourceRoot, pRelativeAddress)
	{
		if (!pSourceRoot)
		{
			return pRelativeAddress;
		}
		if (!pRelativeAddress)
		{
			return pSourceRoot;
		}
		return `${pSourceRoot}.${pRelativeAddress}`;
	}
}

module.exports = XLSXFormFiller;
