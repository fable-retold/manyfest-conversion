const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libFS = require('fs');
const libPath = require('path');
const libOS = require('os');
const libChildProcess = require('child_process');

const PDFTK_BINARY_CANDIDATES = ['pdftk', 'pdftk-java'];

/**
 * PDFFormFiller
 *
 * Fills an AcroForm PDF from a platform JSON payload using a mapping
 * manyfest.  The heavy lifting is delegated to the `pdftk` binary via
 * child_process.execFile with an XFDF input document (chosen over FDF for
 * its native Unicode handling and straightforward XML escaping).
 *
 * `pdftk` must be on the caller's PATH; install on macOS via
 * `brew install pdftk-java` or on Debian/Ubuntu via `apt install pdftk`.
 *
 * When a PDFFormCalculator is supplied (fillPDFWithCalculations), the template's own embedded
 * calculation JavaScript is run after the mapped input values are resolved, so derived cells compute
 * exactly as they would if a user filled the form in Acrobat.
 */
class PDFFormFiller extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'PDFFormFiller';
	}

	/**
	 * Return the first pdftk-style binary found on PATH, or null.
	 */
	resolvePDFTKBinary()
	{
		for (let i = 0; i < PDFTK_BINARY_CANDIDATES.length; i++)
		{
			const tmpCandidate = PDFTK_BINARY_CANDIDATES[i];
			try
			{
				const tmpResult = libChildProcess.spawnSync('which', [tmpCandidate], { encoding: 'utf8' });
				if (tmpResult.status === 0 && tmpResult.stdout)
				{
					const tmpTrimmed = tmpResult.stdout.trim();
					if (tmpTrimmed)
					{
						return tmpTrimmed;
					}
				}
			}
			catch (pError)
			{
				// Ignore and try the next candidate.
			}
		}
		return null;
	}

	/**
	 * Shell out to `pdftk <pdf> dump_data_fields` and parse the output into
	 * an array of field descriptor objects.
	 *
	 * Each returned object has the shape:
	 *   {
	 *     FieldType: 'Text' | 'Button' | 'Choice' | ...,
	 *     FieldName: string,                 // the AcroForm field name
	 *     FieldNameAlt: string | null,       // the "tooltip" alt name (optional)
	 *     FieldFlags: string | null,         // numeric flags as emitted by pdftk
	 *     FieldJustification: string | null, // 'Left' | 'Center' | 'Right'
	 *     FieldValue: string | null,         // current value if any
	 *     FieldStateOptions: string[]        // checkbox / radio states (if any)
	 *   }
	 *
	 * Throws if the PDF does not exist, pdftk is missing, or pdftk exits
	 * with a non-zero status.
	 *
	 * @param {string} pPDFPath
	 * @returns {Array<object>}
	 */
	dumpFormFields(pPDFPath)
	{
		if (!pPDFPath || !libFS.existsSync(pPDFPath))
		{
			throw new Error(`PDF does not exist: ${pPDFPath}`);
		}

		const tmpBinary = this.resolvePDFTKBinary();
		if (!tmpBinary)
		{
			throw new Error('pdftk binary not found on PATH.  Install via "brew install pdftk-java" (macOS) or "apt install pdftk" (Debian/Ubuntu).');
		}

		const tmpResult = libChildProcess.spawnSync(tmpBinary, [pPDFPath, 'dump_data_fields'], { encoding: 'utf8' });
		if (tmpResult.error)
		{
			throw new Error(`Failed to spawn pdftk: ${tmpResult.error.message}`);
		}
		if (tmpResult.status !== 0)
		{
			const tmpStderr = (tmpResult.stderr || '').trim();
			throw new Error(`pdftk dump_data_fields exited with status ${tmpResult.status}: ${tmpStderr}`);
		}

		return this.parseDumpDataFields(tmpResult.stdout || '');
	}

	/**
	 * Parse the raw stdout of `pdftk <pdf> dump_data_fields` into an array of
	 * field descriptor objects.  Pure function; safe to call in tests with a
	 * hand-crafted input string and no pdftk binary on PATH.
	 *
	 * @param {string} pRawOutput
	 * @returns {Array<object>}
	 */
	parseDumpDataFields(pRawOutput)
	{
		if (!pRawOutput || typeof(pRawOutput) !== 'string')
		{
			return [];
		}

		const tmpLines = pRawOutput.split(/\r?\n/);
		const tmpFields = [];
		let tmpCurrent = null;

		const pushCurrent = () =>
		{
			if (tmpCurrent && tmpCurrent.FieldName)
			{
				tmpFields.push(tmpCurrent);
			}
		};

		for (let i = 0; i < tmpLines.length; i++)
		{
			const tmpLine = tmpLines[i];

			if (tmpLine === '---')
			{
				pushCurrent();
				tmpCurrent = (
					{
						FieldType: null,
						FieldName: null,
						FieldNameAlt: null,
						FieldFlags: null,
						FieldJustification: null,
						FieldValue: null,
						FieldStateOptions: []
					});
				continue;
			}

			if (!tmpCurrent)
			{
				// Skip any header lines that appear before the first `---`.
				continue;
			}

			const tmpColonIndex = tmpLine.indexOf(':');
			if (tmpColonIndex < 0)
			{
				continue;
			}

			const tmpKey = tmpLine.substring(0, tmpColonIndex);
			const tmpValue = tmpLine.substring(tmpColonIndex + 1).replace(/^\s+/, '');

			switch (tmpKey)
			{
				case 'FieldType':
					tmpCurrent.FieldType = tmpValue;
					break;
				case 'FieldName':
					tmpCurrent.FieldName = tmpValue;
					break;
				case 'FieldNameAlt':
					tmpCurrent.FieldNameAlt = tmpValue;
					break;
				case 'FieldFlags':
					tmpCurrent.FieldFlags = tmpValue;
					break;
				case 'FieldJustification':
					tmpCurrent.FieldJustification = tmpValue;
					break;
				case 'FieldValue':
					tmpCurrent.FieldValue = tmpValue;
					break;
				case 'FieldStateOption':
					tmpCurrent.FieldStateOptions.push(tmpValue);
					break;
				default:
					// Unknown key; ignore so new pdftk versions don't blow up.
					break;
			}
		}

		// Flush the trailing block.
		pushCurrent();

		return tmpFields;
	}

	/**
	 * Normalize a descriptor (old or new shape) to a flat array of target
	 * specs.  Mirrors MappingManyfestBuilder.normalizeDescriptorTargets so
	 * the PDF filler stays self-sufficient even when the builder service
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
	 * Escape a string for safe inclusion inside an XFDF <value> element.
	 */
	escapeXML(pValue)
	{
		if (pValue === null || typeof(pValue) === 'undefined')
		{
			return '';
		}
		return String(pValue)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	/**
	 * Resolve every mapped descriptor against the source payload into an ordered list of
	 * { FieldName, Value } targets, logging success / warning / error onto the ConversionReport as it
	 * goes.  This is the resolution half of buildXFDF, factored out so a calculation pass can run
	 * between resolution and XFDF generation.
	 *
	 * @param {object} pMappingManyfest - Live Manyfest instance
	 * @param {object} pSourceData - The platform JSON payload (root level)
	 * @param {object} pReport - ConversionReport to annotate
	 * @param {object} pConversionReportService - The ConversionReport service
	 * @returns {{ Fields: Array<{FieldName:string, Value:*}>, ValueMap: Object }}
	 */
	resolveMappedValues(pMappingManyfest, pSourceData, pReport, pConversionReportService)
	{
		const tmpFields = [];
		const tmpValueMap = {};

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
			// this descriptor consumes the same value.
			let tmpValue;
			let tmpResolutionError = null;
			try
			{
				tmpValue = pMappingManyfest.getValueAtAddress(pSourceData, tmpFullAddress);
			}
			catch (pError)
			{
				tmpResolutionError = pError;
			}

			for (let t = 0; t < tmpTargets.length; t++)
			{
				const tmpTarget = tmpTargets[t] || {};
				const tmpFieldName = tmpTarget.TargetFieldName || tmpRelativeAddress;

				if (tmpResolutionError)
				{
					pConversionReportService.logError(
						pReport,
						tmpFieldName,
						tmpFullAddress,
						`Error resolving source address: ${tmpResolutionError.message}`);
					continue;
				}

				// PDF Button/Checkbox rows are explicitly warn-and-skip in v1.
				if ((tmpTarget.TargetFieldType || '').toLowerCase() === 'button')
				{
					pConversionReportService.logWarning(
						pReport,
						tmpFieldName,
						tmpFullAddress,
						'PDF checkbox/Button mappings are warn-and-skip in manyfest-conversion v1.');
					continue;
				}

				if (typeof(tmpValue) === 'undefined' || tmpValue === null)
				{
					pConversionReportService.logWarning(
						pReport,
						tmpFieldName,
						tmpFullAddress,
						'Source address did not resolve to a value in the payload.');
					continue;
				}

				if (typeof(tmpValue) === 'object')
				{
					pConversionReportService.logError(
						pReport,
						tmpFieldName,
						tmpFullAddress,
						'Source address resolved to an object/array, not a scalar.');
					continue;
				}

				tmpFields.push({ FieldName: tmpFieldName, Value: tmpValue });
				tmpValueMap[tmpFieldName] = tmpValue;

				pConversionReportService.logSuccess(pReport, tmpFieldName, tmpFullAddress, tmpValue);
			}
		}

		return { Fields: tmpFields, ValueMap: tmpValueMap };
	}

	/**
	 * Build an XFDF document from an ordered list of { FieldName, Value } targets.  Pure function.
	 *
	 * @param {Array<{FieldName:string, Value:*}>} pFields
	 * @returns {{ xfdf: string, fieldCount: number }}
	 */
	buildXFDFFromFields(pFields)
	{
		const tmpFieldLines = [];
		const tmpList = pFields || [];
		for (let i = 0; i < tmpList.length; i++)
		{
			const tmpEscapedName = this.escapeXML(tmpList[i].FieldName);
			const tmpEscapedValue = this.escapeXML(tmpList[i].Value);
			tmpFieldLines.push(`    <field name="${tmpEscapedName}"><value>${tmpEscapedValue}</value></field>`);
		}

		const tmpXFDF = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">',
			'  <fields>',
			tmpFieldLines.join('\n'),
			'  </fields>',
			'</xfdf>',
			''
		].join('\n');

		return { xfdf: tmpXFDF, fieldCount: tmpFieldLines.length };
	}

	/**
	 * Build an XFDF document from a mapping manyfest + source data object.
	 * This is a pure function (no IO, no pdftk) and returns both the XFDF
	 * string and a structured report describing which descriptors were
	 * emitted, skipped, or errored.
	 *
	 * @param {object} pMappingManyfest - Live Manyfest instance
	 * @param {object} pSourceData - The platform JSON payload (root level)
	 * @param {object} pReport - ConversionReport to annotate (required)
	 * @param {object} pConversionReportService - The ConversionReport service
	 * @returns {{ xfdf: string, fieldCount: number }}
	 */
	buildXFDF(pMappingManyfest, pSourceData, pReport, pConversionReportService)
	{
		const tmpResolved = this.resolveMappedValues(pMappingManyfest, pSourceData, pReport, pConversionReportService);
		return this.buildXFDFFromFields(tmpResolved.Fields);
	}

	/**
	 * Shell out to pdftk to apply an XFDF file to a template PDF, writing
	 * a filled PDF to the given output path.  Uses execFile (not exec) so
	 * filenames cannot be mis-interpreted as shell arguments.
	 */
	runPDFTK(pTemplatePDFPath, pXFDFPath, pOutputPDFPath)
	{
		const tmpBinary = this.resolvePDFTKBinary();
		if (!tmpBinary)
		{
			throw new Error('pdftk binary not found on PATH.  Install via "brew install pdftk-java" (macOS) or "apt install pdftk" (Debian/Ubuntu).');
		}

		const tmpArgs = [pTemplatePDFPath, 'fill_form', pXFDFPath, 'output', pOutputPDFPath];
		const tmpResult = libChildProcess.spawnSync(tmpBinary, tmpArgs, { encoding: 'utf8' });
		if (tmpResult.error)
		{
			throw new Error(`Failed to spawn pdftk: ${tmpResult.error.message}`);
		}
		if (tmpResult.status !== 0)
		{
			const tmpStderr = (tmpResult.stderr || '').trim();
			throw new Error(`pdftk exited with status ${tmpResult.status}: ${tmpStderr}`);
		}
		return true;
	}

	/**
	 * Write an XFDF string to a temp file, run pdftk to apply it to the template, and clean up.
	 *
	 * @param {string} pTemplatePDFPath
	 * @param {string} pXFDF
	 * @param {string} pOutputPDFPath
	 */
	writeAndRunPDFTK(pTemplatePDFPath, pXFDF, pOutputPDFPath)
	{
		const tmpTempDir = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'mfconv-'));
		const tmpXFDFPath = libPath.join(tmpTempDir, 'fill.xfdf');
		try
		{
			libFS.writeFileSync(tmpXFDFPath, pXFDF, 'utf8');
			this.runPDFTK(pTemplatePDFPath, tmpXFDFPath, pOutputPDFPath);
		}
		finally
		{
			try { libFS.unlinkSync(tmpXFDFPath); } catch (pCleanupError) { /* ignore */ }
			try { libFS.rmdirSync(tmpTempDir); } catch (pCleanupError) { /* ignore */ }
		}
	}

	/**
	 * End-to-end fill: build XFDF, write it to a temp file, run pdftk,
	 * clean up.  Does NOT run the form's calculation scripts -- see
	 * fillPDFWithCalculations for "fill the math like Acrobat" behavior.
	 *
	 * @param {object} pMappingManyfest - Live Manyfest instance
	 * @param {object} pSourceData - The platform JSON payload
	 * @param {string} pTemplatePDFPath
	 * @param {string} pOutputPDFPath
	 * @param {object} pReport - ConversionReport to annotate
	 * @param {object} pConversionReportService
	 * @returns {object} the (same) report, with stats finalized
	 */
	fillPDF(pMappingManyfest, pSourceData, pTemplatePDFPath, pOutputPDFPath, pReport, pConversionReportService)
	{
		if (!libFS.existsSync(pTemplatePDFPath))
		{
			pConversionReportService.logError(pReport, null, null, `Template PDF does not exist: ${pTemplatePDFPath}`);
			pConversionReportService.finalize(pReport);
			throw new Error(`Template PDF does not exist: ${pTemplatePDFPath}`);
		}

		const tmpBuild = this.buildXFDF(pMappingManyfest, pSourceData, pReport, pConversionReportService);

		try
		{
			this.writeAndRunPDFTK(pTemplatePDFPath, tmpBuild.xfdf, pOutputPDFPath);
		}
		catch (pError)
		{
			pConversionReportService.logError(pReport, null, null, `PDF fill failed: ${pError.message}`);
			pConversionReportService.finalize(pReport);
			throw pError;
		}

		pConversionReportService.finalize(pReport);
		return pReport;
	}

	/**
	 * End-to-end fill that ALSO runs the template's own embedded calculation JavaScript, so derived
	 * cells compute exactly as they would if a user filled the form in Acrobat.
	 *
	 * Flow: resolve the mapped (input) values, run the form's `/CO` calculation chain seeded with them
	 * via the PDFFormCalculator, merge the computed values over the mapped ones (a calculated field is
	 * authoritative, as in Acrobat), then build the XFDF and run pdftk.
	 *
	 * A calculation failure is a warning, never fatal: the fill still produces the mapped values.
	 *
	 * @param {object} pMappingManyfest - Live Manyfest instance
	 * @param {object} pSourceData - The platform JSON payload
	 * @param {string} pTemplatePDFPath
	 * @param {string} pOutputPDFPath
	 * @param {object} pReport - ConversionReport to annotate
	 * @param {object} pConversionReportService
	 * @param {object} pCalculator - A PDFFormCalculator instance (required for the calculation pass)
	 * @param {object} [pOptions] - { Calculate=true, MaxPasses, TimeoutMS }
	 * @returns {Promise<object>} the (same) report, with stats finalized
	 */
	async fillPDFWithCalculations(pMappingManyfest, pSourceData, pTemplatePDFPath, pOutputPDFPath, pReport, pConversionReportService, pCalculator, pOptions)
	{
		const tmpOptions = pOptions || {};

		if (!libFS.existsSync(pTemplatePDFPath))
		{
			pConversionReportService.logError(pReport, null, null, `Template PDF does not exist: ${pTemplatePDFPath}`);
			pConversionReportService.finalize(pReport);
			throw new Error(`Template PDF does not exist: ${pTemplatePDFPath}`);
		}

		const tmpResolved = this.resolveMappedValues(pMappingManyfest, pSourceData, pReport, pConversionReportService);
		const tmpFields = tmpResolved.Fields.slice();

		// Run the form's own calculation scripts, seeded with the resolved input values.
		if (pCalculator && tmpOptions.Calculate !== false)
		{
			try
			{
				const tmpCalcResult = await pCalculator.computeCalculatedFields(pTemplatePDFPath, tmpResolved.ValueMap, tmpOptions);
				const tmpComputedNames = Object.keys(tmpCalcResult.Values || {});
				const tmpIndexByName = {};
				for (let i = 0; i < tmpFields.length; i++)
				{
					tmpIndexByName[tmpFields[i].FieldName] = i;
				}
				for (let i = 0; i < tmpComputedNames.length; i++)
				{
					const tmpName = tmpComputedNames[i];
					const tmpValue = tmpCalcResult.Values[tmpName];
					if (Object.prototype.hasOwnProperty.call(tmpIndexByName, tmpName))
					{
						// A calculated field is authoritative (Acrobat recomputes it), so override the mapped value.
						tmpFields[tmpIndexByName[tmpName]].Value = tmpValue;
					}
					else
					{
						tmpFields.push({ FieldName: tmpName, Value: tmpValue });
					}
					pConversionReportService.logSuccess(pReport, tmpName, '(calculated by form JavaScript)', tmpValue);
				}

				// Surface any field that HAS a calc script but could not be evaluated — never a silent blank.
				const tmpSkipped = Array.isArray(tmpCalcResult.Skipped) ? tmpCalcResult.Skipped : [];
				for (let s = 0; s < tmpSkipped.length; s++)
				{
					pConversionReportService.logWarning(pReport, tmpSkipped[s].Field, '(calculation)', `Field has a calculation script that could not be evaluated: ${tmpSkipped[s].Message}`);
				}
			}
			catch (pError)
			{
				pConversionReportService.logWarning(pReport, null, null, `Calculation pass failed; filled mapped values only: ${pError.message}`);
			}
		}

		const tmpBuild = this.buildXFDFFromFields(tmpFields);

		try
		{
			this.writeAndRunPDFTK(pTemplatePDFPath, tmpBuild.xfdf, pOutputPDFPath);
		}
		catch (pError)
		{
			pConversionReportService.logError(pReport, null, null, `PDF fill failed: ${pError.message}`);
			pConversionReportService.finalize(pReport);
			throw pError;
		}

		pConversionReportService.finalize(pReport);
		return pReport;
	}

	/**
	 * Join a source root address with a relative descriptor address.
	 * Shared implementation with MappingManyfestBuilder.joinAddress().
	 */
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

module.exports = PDFFormFiller;
