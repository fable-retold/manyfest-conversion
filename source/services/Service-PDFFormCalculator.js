const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libVM = require('vm');
const libFS = require('fs');

const libAcrobatFormsAPI = require('./acrobat-forms-api.js');

/**
 * PDFFormCalculator
 *
 * Runs an AcroForm's OWN embedded JavaScript (document-level scripts + the `/CO` calculation chain)
 * so that derived cells (E = C - D, G = E / F, averages, sums, ...) compute exactly as they would if
 * a human filled the form in Acrobat -- because no non-Acrobat viewer, and neither pdftk nor pypdf,
 * executes that JavaScript.
 *
 * The template's scripts and calculation order are read with pdf-lib, then executed in a Node `vm`
 * sandbox whose global is a faithful Acrobat Forms API (ported from Mozilla pdf.js; see
 * acrobat-forms-api.js). Only fields that carry a calculation script are ever produced -- input and
 * non-calculated fields are never touched -- and a field whose script throws is left unchanged (a
 * wrong number is worse than a blank), so the pass is strictly additive. Fields that have a calc
 * script but could not be computed are reported in `Skipped` so callers can surface them loudly
 * rather than silently shipping a blank.
 *
 * pdf-lib is required lazily; a caller that never runs calculations does not need it installed.
 */
class PDFFormCalculator extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'PDFFormCalculator';
	}

	/**
	 * Coerce any pdf-lib string/name object (following an indirect reference if needed) to plain text.
	 */
	_objectText(pContext, pObject, pPDFLib)
	{
		let tmpObject = pObject;
		if (tmpObject instanceof pPDFLib.PDFRef)
		{
			try { tmpObject = pContext.lookup(tmpObject); }
			catch (pError) { return ''; }
		}
		if (!tmpObject)
		{
			return '';
		}
		if (tmpObject instanceof pPDFLib.PDFName)
		{
			try { return tmpObject.asString().replace(/^\//, ''); }
			catch (pError) { return ''; }
		}
		if (typeof(tmpObject.decodeText) === 'function')
		{
			try { return tmpObject.decodeText(); }
			catch (pError) { /* fall through */ }
		}
		if (typeof(tmpObject.asString) === 'function')
		{
			try { return tmpObject.asString(); }
			catch (pError) { /* fall through */ }
		}
		return '';
	}

	/**
	 * Read the JavaScript out of a `/JS` entry, which may be a string or a (possibly compressed) stream.
	 */
	_readJavaScript(pContext, pObject, pPDFLib)
	{
		let tmpObject = pObject;
		if (tmpObject instanceof pPDFLib.PDFRef)
		{
			try { tmpObject = pContext.lookup(tmpObject); }
			catch (pError) { return ''; }
		}
		if (!tmpObject)
		{
			return '';
		}
		if (tmpObject instanceof pPDFLib.PDFRawStream)
		{
			try { return Buffer.from(pPDFLib.decodePDFRawStream(tmpObject).decode()).toString('latin1'); }
			catch (pError) { return ''; }
		}
		return this._objectText(pContext, tmpObject, pPDFLib);
	}

	/**
	 * Follow an indirect reference to a dictionary/array (or return the object if it's direct).
	 */
	_resolve(pContext, pObject, pPDFLib)
	{
		if (pObject instanceof pPDFLib.PDFRef)
		{
			try { return pContext.lookup(pObject); }
			catch (pError) { return null; }
		}
		return pObject || null;
	}

	/**
	 * Extract the document-level JavaScript (`/Root /Names /JavaScript` name tree). These define helper
	 * functions/globals that field calculation scripts may call, so they must run first.
	 *
	 * @returns {Array<string>} the document-level scripts, in name-tree order.
	 */
	_extractDocScripts(pContext, pCatalog, pPDFLib)
	{
		const tmpScripts = [];
		try
		{
			const tmpNames = this._resolve(pContext, pCatalog.get(pPDFLib.PDFName.of('Names')), pPDFLib);
			if (!tmpNames || typeof(tmpNames.get) !== 'function') { return tmpScripts; }
			const tmpJSNode = this._resolve(pContext, tmpNames.get(pPDFLib.PDFName.of('JavaScript')), pPDFLib);
			if (!tmpJSNode) { return tmpScripts; }

			const fWalk = (pNode) =>
			{
				const tmpNode = this._resolve(pContext, pNode, pPDFLib);
				if (!tmpNode || typeof(tmpNode.get) !== 'function') { return; }
				// Leaf: /Names is [ nameString, actionDict, nameString, actionDict, ... ]
				const tmpNamesArray = this._resolve(pContext, tmpNode.get(pPDFLib.PDFName.of('Names')), pPDFLib);
				if (tmpNamesArray && typeof(tmpNamesArray.size) === 'function')
				{
					for (let i = 1; i < tmpNamesArray.size(); i += 2)
					{
						const tmpAction = this._resolve(pContext, tmpNamesArray.get(i), pPDFLib);
						if (tmpAction && typeof(tmpAction.get) === 'function')
						{
							const tmpJS = this._readJavaScript(pContext, tmpAction.get(pPDFLib.PDFName.of('JS')), pPDFLib);
							if (tmpJS) { tmpScripts.push(tmpJS); }
						}
					}
				}
				// Intermediate node: /Kids
				const tmpKids = this._resolve(pContext, tmpNode.get(pPDFLib.PDFName.of('Kids')), pPDFLib);
				if (tmpKids && typeof(tmpKids.size) === 'function')
				{
					for (let i = 0; i < tmpKids.size(); i++) { fWalk(tmpKids.get(i)); }
				}
			};
			fWalk(tmpJSNode);
		}
		catch (pError) { /* document-level scripts are optional; ignore extraction failures */ }
		return tmpScripts;
	}

	/**
	 * Extract the calculation model from a template PDF's AcroForm.
	 *
	 * @param {Buffer|Uint8Array} pPDFBytes
	 * @returns {Promise<{Values: Object, Scripts: Object, Order: Array<string>, DocScripts: Array<string>}>}
	 */
	async extractCalcModel(pPDFBytes)
	{
		const libPDFLib = require('pdf-lib');
		const tmpDocument = await libPDFLib.PDFDocument.load(pPDFBytes, { ignoreEncryption: true, updateMetadata: false });
		const tmpContext = tmpDocument.context;
		const tmpForm = tmpDocument.getForm();

		const tmpValues = {};
		const tmpScripts = {};
		const tmpFormatScripts = {};
		const tmpValidateScripts = {};

		// Read the JavaScript of a field additional-action (/AA <key>), if present.
		const fActionJS = (pAA, pKey) =>
		{
			const tmpAction = this._resolve(tmpContext, pAA.get(libPDFLib.PDFName.of(pKey)), libPDFLib);
			if (tmpAction && typeof(tmpAction.get) === 'function')
			{
				return this._readJavaScript(tmpContext, tmpAction.get(libPDFLib.PDFName.of('JS')), libPDFLib);
			}
			return '';
		};

		const tmpFields = tmpForm.getFields();
		for (let i = 0; i < tmpFields.length; i++)
		{
			const tmpField = tmpFields[i];
			let tmpName = '';
			try { tmpName = tmpField.getName(); }
			catch (pError) { tmpName = ''; }
			if (!tmpName)
			{
				continue;
			}

			const tmpDict = tmpField.acroField.dict;
			tmpValues[tmpName] = this._objectText(tmpContext, tmpDict.get(libPDFLib.PDFName.of('V')), libPDFLib);

			// Field additional actions: /C calculate, /F format, /V validate (all standard PDF/AcroForm).
			const tmpAA = this._resolve(tmpContext, tmpDict.get(libPDFLib.PDFName.of('AA')), libPDFLib);
			if (tmpAA && typeof(tmpAA.get) === 'function')
			{
				const tmpCalcJS = fActionJS(tmpAA, 'C');
				if (tmpCalcJS) { tmpScripts[tmpName] = tmpCalcJS; }
				const tmpFormatJS = fActionJS(tmpAA, 'F');
				if (tmpFormatJS) { tmpFormatScripts[tmpName] = tmpFormatJS; }
				const tmpValidateJS = fActionJS(tmpAA, 'V');
				if (tmpValidateJS) { tmpValidateScripts[tmpName] = tmpValidateJS; }
			}
		}

		// /CO -- the calculation order (array of field references).
		const tmpOrder = [];
		const tmpCO = this._resolve(tmpContext, tmpForm.acroForm.dict.get(libPDFLib.PDFName.of('CO')), libPDFLib);
		if (tmpCO && typeof(tmpCO.size) === 'function')
		{
			for (let i = 0; i < tmpCO.size(); i++)
			{
				const tmpFieldDict = this._resolve(tmpContext, tmpCO.get(i), libPDFLib);
				if (tmpFieldDict && typeof(tmpFieldDict.get) === 'function')
				{
					const tmpName = this._objectText(tmpContext, tmpFieldDict.get(libPDFLib.PDFName.of('T')), libPDFLib);
					if (tmpName)
					{
						tmpOrder.push(tmpName);
					}
				}
			}
		}

		const tmpDocScripts = this._extractDocScripts(tmpContext, tmpDocument.catalog, libPDFLib);

		return { Values: tmpValues, Scripts: tmpScripts, FormatScripts: tmpFormatScripts, ValidateScripts: tmpValidateScripts, Order: tmpOrder, DocScripts: tmpDocScripts };
	}

	/**
	 * Execute a calculation model against a set of seed (input) values, returning the values of the
	 * fields that carry a calculation script. Pure and synchronous -- no pdf-lib, no IO -- so the
	 * Acrobat-forms behaviour can be unit-tested with a hand-built model.
	 *
	 * @param {{Values?: Object, Scripts: Object, Order?: Array<string>, DocScripts?: Array<string>}} pModel
	 * @param {Object} pSeedValues - fieldName -> value overrides (the mapped input values)
	 * @param {Object} [pOptions] - { MaxPasses=8, TimeoutMS=2000 }
	 * @returns {{Values: Object, Computed: Array<string>, Skipped: Array<{Field:string, Message:string}>, Warnings: Array<string>}}
	 */
	runCalculations(pModel, pSeedValues, pOptions)
	{
		const tmpOptions = pOptions || {};
		const tmpMaxPasses = (typeof(tmpOptions.MaxPasses) === 'number') ? tmpOptions.MaxPasses : 8;
		const tmpTimeoutMS = (typeof(tmpOptions.TimeoutMS) === 'number') ? tmpOptions.TimeoutMS : 2000;

		const tmpModel = pModel || {};
		const tmpScripts = tmpModel.Scripts || {};
		const tmpDocScripts = Array.isArray(tmpModel.DocScripts) ? tmpModel.DocScripts : [];
		const tmpValues = Object.assign({}, tmpModel.Values || {}, pSeedValues || {});
		const tmpOrder = (Array.isArray(tmpModel.Order) && tmpModel.Order.length > 0) ? tmpModel.Order : Object.keys(tmpScripts);
		const tmpScriptedFields = tmpOrder.filter((pName) => (typeof(tmpScripts[pName]) === 'string') && tmpScripts[pName].trim());

		// Every field the form references must be resolvable via getField(); ensure ordered/scripted
		// fields exist in the value model (a real extract already carries every field's /V).
		for (let i = 0; i < tmpOrder.length; i++) { if (!(tmpOrder[i] in tmpValues)) { tmpValues[tmpOrder[i]] = ''; } }
		const tmpScriptNames = Object.keys(tmpScripts);
		for (let i = 0; i < tmpScriptNames.length; i++) { if (!(tmpScriptNames[i] in tmpValues)) { tmpValues[tmpScriptNames[i]] = ''; } }

		// The value model the Acrobat Field objects read/write through.
		const tmpNames = Object.keys(tmpValues);
		const tmpNameSet = {};
		for (let i = 0; i < tmpNames.length; i++) { tmpNameSet[tmpNames[i]] = true; }
		const tmpState = {
			names: tmpNames,
			has: (pName) => tmpNameSet[pName] === true,
			get: (pName) => tmpValues[pName],
			set: (pName, pValue) => { if (tmpNameSet[pName] !== true) { tmpNameSet[pName] = true; tmpNames.push(pName); } tmpValues[pName] = pValue; }
		};

		const tmpRecalcRef = { fn: null };
		const tmpBuilt = libAcrobatFormsAPI.buildSandbox(tmpState, tmpRecalcRef);
		const tmpContext = libVM.createContext(tmpBuilt.sandbox);

		const tmpComputed = {};
		const tmpSkipped = [];

		// Run any document-level scripts once, to define helper functions/globals for field scripts.
		for (let i = 0; i < tmpDocScripts.length; i++)
		{
			try { libVM.runInContext(tmpDocScripts[i], tmpContext, { timeout: tmpTimeoutMS }); }
			catch (pError) { /* a broken document-level script must not abort the calculation */ }
		}

		const fRunOnePass = () =>
		{
			let tmpChanged = false;
			for (let i = 0; i < tmpScriptedFields.length; i++)
			{
				const tmpName = tmpScriptedFields[i];
				const tmpBefore = tmpState.get(tmpName);

				const tmpEvent = libAcrobatFormsAPI.makeCalculateEvent(tmpBuilt.doc, tmpName);
				tmpBuilt.setEvent(tmpEvent);

				try
				{
					libVM.runInContext(tmpScripts[tmpName], tmpContext, { timeout: tmpTimeoutMS });
					tmpState.set(tmpName, tmpEvent.value);
					tmpComputed[tmpName] = tmpEvent.value;
					// A field that computed cleanly is no longer "skipped".
					for (let s = tmpSkipped.length - 1; s >= 0; s--) { if (tmpSkipped[s].Field === tmpName) { tmpSkipped.splice(s, 1); } }
				}
				catch (pError)
				{
					if (!Object.prototype.hasOwnProperty.call(tmpComputed, tmpName))
					{
						let tmpAlready = false;
						for (let s = 0; s < tmpSkipped.length; s++) { if (tmpSkipped[s].Field === tmpName) { tmpAlready = true; break; } }
						if (!tmpAlready) { tmpSkipped.push({ Field: tmpName, Message: pError.message }); }
					}
				}

				if (tmpState.get(tmpName) !== tmpBefore) { tmpChanged = true; }
			}
			return tmpChanged;
		};

		// calculateNow() from within a script re-runs one pass.
		tmpRecalcRef.fn = fRunOnePass;

		for (let tmpPass = 0; tmpPass < tmpMaxPasses; tmpPass++)
		{
			if (!fRunOnePass())
			{
				break;
			}
		}

		const tmpResultValues = {};
		const tmpComputedNames = Object.keys(tmpComputed);
		for (let i = 0; i < tmpComputedNames.length; i++)
		{
			tmpResultValues[tmpComputedNames[i]] = tmpState.get(tmpComputedNames[i]);
		}

		return { Values: tmpResultValues, Computed: tmpComputedNames, Skipped: tmpSkipped, Warnings: tmpBuilt.warnings };
	}

	/**
	 * Read a template PDF from disk, run its calculation scripts seeded with the given input values,
	 * and return the computed calculated-field values.
	 *
	 * @param {string} pTemplatePDFPath
	 * @param {Object} pSeedValues - fieldName -> value (the mapped input values)
	 * @param {Object} [pOptions]
	 * @returns {Promise<{Values: Object, Computed: Array<string>, Skipped: Array<object>, Warnings: Array<string>}>}
	 */
	async computeCalculatedFields(pTemplatePDFPath, pSeedValues, pOptions)
	{
		const tmpBytes = libFS.readFileSync(pTemplatePDFPath);
		const tmpModel = await this.extractCalcModel(tmpBytes);
		return this.runCalculations(tmpModel, pSeedValues || {}, pOptions);
	}

	/**
	 * Run the form's Format (/AA/F) and Validate (/AA/V) scripts against the given (already-computed)
	 * field values -- Acrobat's display-formatting and validation/coloring actions. Returns each
	 * field's formatted display string, any textColor a validate/format script sets, and which fields
	 * a validate script rejected. Does NOT change stored values.
	 *
	 * @param {object} pModel - from extractCalcModel (FormatScripts/ValidateScripts/DocScripts/Values/Order).
	 * @param {Object} pValues - the final field values (mapped inputs + calculated results).
	 * @param {Array<string>} [pTouchedNames] - restrict to these fields (default: all with values).
	 * @param {Object} [pOptions] - { TimeoutMS=2000 }.
	 * @returns {{DisplayValues: Object, Colors: Object, Rejected: Array<string>, Warnings: Array<string>}}
	 */
	runFormatAndValidate(pModel, pValues, pTouchedNames, pOptions)
	{
		const tmpOptions = pOptions || {};
		const tmpTimeoutMS = (typeof(tmpOptions.TimeoutMS) === 'number') ? tmpOptions.TimeoutMS : 2000;

		const tmpModel = pModel || {};
		const tmpFormatScripts = tmpModel.FormatScripts || {};
		const tmpValidateScripts = tmpModel.ValidateScripts || {};
		const tmpDocScripts = Array.isArray(tmpModel.DocScripts) ? tmpModel.DocScripts : [];
		const tmpValues = Object.assign({}, tmpModel.Values || {}, pValues || {});

		const fEnsure = (pNameList) => { for (let i = 0; i < pNameList.length; i++) { if (!(pNameList[i] in tmpValues)) { tmpValues[pNameList[i]] = ''; } } };
		fEnsure(Array.isArray(tmpModel.Order) ? tmpModel.Order : []);
		fEnsure(Object.keys(tmpModel.Scripts || {}));
		fEnsure(Object.keys(tmpFormatScripts));
		fEnsure(Object.keys(tmpValidateScripts));

		const tmpNames = Object.keys(tmpValues);
		const tmpNameSet = {};
		for (let i = 0; i < tmpNames.length; i++) { tmpNameSet[tmpNames[i]] = true; }
		const tmpState = {
			names: tmpNames,
			has: (pName) => tmpNameSet[pName] === true,
			get: (pName) => tmpValues[pName],
			set: (pName, pValue) => { if (tmpNameSet[pName] !== true) { tmpNameSet[pName] = true; tmpNames.push(pName); } tmpValues[pName] = pValue; }
		};

		const tmpBuilt = libAcrobatFormsAPI.buildSandbox(tmpState, { fn: null });
		const tmpContext = libVM.createContext(tmpBuilt.sandbox);

		for (let i = 0; i < tmpDocScripts.length; i++)
		{
			try { libVM.runInContext(tmpDocScripts[i], tmpContext, { timeout: tmpTimeoutMS }); }
			catch (pError) { /* optional */ }
		}

		const tmpTouched = (Array.isArray(pTouchedNames) && pTouchedNames.length > 0) ? pTouchedNames : tmpNames;

		const tmpDisplayValues = {};
		const tmpColors = {};
		const tmpRejected = [];

		for (let i = 0; i < tmpTouched.length; i++)
		{
			const tmpName = tmpTouched[i];
			const tmpField = tmpBuilt.doc.getField(tmpName);
			if (tmpField) { tmpField._textColorSet = false; }

			// Validate (/AA/V): acceptance + side effects (e.g. textColor).
			if (typeof(tmpValidateScripts[tmpName]) === 'string' && tmpValidateScripts[tmpName].trim())
			{
				const tmpEvent = libAcrobatFormsAPI.makeFieldEvent(tmpBuilt.doc, tmpName, 'Validate');
				tmpBuilt.setEvent(tmpEvent);
				try
				{
					libVM.runInContext(tmpValidateScripts[tmpName], tmpContext, { timeout: tmpTimeoutMS });
					if (tmpEvent.rc === false) { tmpRejected.push(tmpName); }
				}
				catch (pError) { /* a failed validate must not abort the fill */ }
			}

			// Format (/AA/F): the display string. Does NOT change the stored value.
			if (typeof(tmpFormatScripts[tmpName]) === 'string' && tmpFormatScripts[tmpName].trim())
			{
				const tmpEvent = libAcrobatFormsAPI.makeFieldEvent(tmpBuilt.doc, tmpName, 'Format');
				tmpBuilt.setEvent(tmpEvent);
				try
				{
					libVM.runInContext(tmpFormatScripts[tmpName], tmpContext, { timeout: tmpTimeoutMS });
					tmpDisplayValues[tmpName] = tmpEvent.value;
				}
				catch (pError) { /* a failed format leaves the raw value */ }
			}

			if (tmpField && tmpField._textColorSet)
			{
				tmpColors[tmpName] = tmpField.textColor;
			}
		}

		return { DisplayValues: tmpDisplayValues, Colors: tmpColors, Rejected: tmpRejected, Warnings: tmpBuilt.warnings };
	}

	/**
	 * Convert an Acrobat color array (['G',g] | ['RGB',r,g,b] | ['CMYK',c,m,y,k]) to the PDF /DA
	 * color operator string, or null for transparent/unsupported.
	 */
	_colorOperator(pColor)
	{
		if (!Array.isArray(pColor) || pColor.length === 0) { return null; }
		const tmpSpace = pColor[0];
		if (tmpSpace === 'G' && pColor.length >= 2) { return `${pColor[1]} g`; }
		if (tmpSpace === 'RGB' && pColor.length >= 4) { return `${pColor[1]} ${pColor[2]} ${pColor[3]} rg`; }
		if (tmpSpace === 'CMYK' && pColor.length >= 5) { return `${pColor[1]} ${pColor[2]} ${pColor[3]} ${pColor[4]} k`; }
		return null;
	}

	/**
	 * Return a copy of the template PDF with the given fields' /DA text color set (so a subsequent
	 * pdftk fill regenerates their appearance in that color). Only the /DA color operator is changed;
	 * font/size and everything else are preserved.
	 *
	 * @param {string} pTemplatePDFPath
	 * @param {Object} pColorsMap - fieldName -> Acrobat color array
	 * @returns {Promise<Buffer>} the patched PDF bytes
	 */
	async applyFieldColors(pTemplatePDFPath, pColorsMap)
	{
		const libPDFLib = require('pdf-lib');
		const tmpBytes = libFS.readFileSync(pTemplatePDFPath);
		const tmpDocument = await libPDFLib.PDFDocument.load(tmpBytes, { ignoreEncryption: true, updateMetadata: false });
		const tmpForm = tmpDocument.getForm();

		const tmpByName = {};
		const tmpFields = tmpForm.getFields();
		for (let i = 0; i < tmpFields.length; i++)
		{
			let tmpName = '';
			try { tmpName = tmpFields[i].getName(); }
			catch (pError) { tmpName = ''; }
			if (tmpName) { tmpByName[tmpName] = tmpFields[i]; }
		}

		const tmpNames = Object.keys(pColorsMap || {});
		for (let i = 0; i < tmpNames.length; i++)
		{
			const tmpName = tmpNames[i];
			const tmpOperator = this._colorOperator(pColorsMap[tmpName]);
			if (!tmpOperator) { continue; }
			const tmpField = tmpByName[tmpName];
			if (!tmpField) { continue; }

			const tmpDict = tmpField.acroField.dict;
			let tmpDA = '';
			const tmpDAObj = tmpDict.get(libPDFLib.PDFName.of('DA'));
			if (tmpDAObj)
			{
				try { tmpDA = (typeof(tmpDAObj.decodeText) === 'function') ? tmpDAObj.decodeText() : tmpDAObj.asString(); }
				catch (pError) { tmpDA = ''; }
			}
			let tmpNewDA;
			if (/\bTf\b/.test(tmpDA)) { tmpNewDA = tmpDA.replace(/(\bTf\b)[\s\S]*/, `$1 ${tmpOperator}`); }
			else { tmpNewDA = (tmpDA ? `${tmpDA} ` : '') + tmpOperator; }
			tmpDict.set(libPDFLib.PDFName.of('DA'), libPDFLib.PDFString.of(tmpNewDA));
		}

		const tmpOut = await tmpDocument.save({ updateFieldAppearances: false });
		return Buffer.from(tmpOut);
	}

	/**
	 * Full "act like Acrobat" pass over a template: run the calculation chain, then the format and
	 * validate scripts, seeded with the caller's input values.
	 *
	 * @param {string} pTemplatePDFPath
	 * @param {Object} pSeedValues - fieldName -> value (the mapped input values)
	 * @param {Array<string>} [pTouchedNames] - the fields being written (for format/validate scope)
	 * @param {Object} [pOptions]
	 * @returns {Promise<{Values:Object, Computed:Array, Skipped:Array, DisplayValues:Object, Colors:Object, Rejected:Array, Warnings:Array}>}
	 */
	async computeAll(pTemplatePDFPath, pSeedValues, pTouchedNames, pOptions)
	{
		const tmpBytes = libFS.readFileSync(pTemplatePDFPath);
		const tmpModel = await this.extractCalcModel(tmpBytes);
		const tmpCalc = this.runCalculations(tmpModel, pSeedValues || {}, pOptions);
		const tmpFinalValues = Object.assign({}, tmpModel.Values || {}, pSeedValues || {}, tmpCalc.Values || {});

		// Format/validate scope = the caller's touched fields plus everything the calc chain produced.
		let tmpTouched = Array.isArray(pTouchedNames) ? pTouchedNames.slice() : [];
		for (let i = 0; i < (tmpCalc.Computed || []).length; i++)
		{
			if (tmpTouched.indexOf(tmpCalc.Computed[i]) < 0) { tmpTouched.push(tmpCalc.Computed[i]); }
		}
		const tmpFV = this.runFormatAndValidate(tmpModel, tmpFinalValues, (tmpTouched.length > 0 ? tmpTouched : undefined), pOptions);
		return {
			Values: tmpCalc.Values,
			Computed: tmpCalc.Computed,
			Skipped: tmpCalc.Skipped,
			DisplayValues: tmpFV.DisplayValues,
			Colors: tmpFV.Colors,
			Rejected: tmpFV.Rejected,
			Warnings: (tmpCalc.Warnings || []).concat(tmpFV.Warnings || [])
		};
	}
}

module.exports = PDFFormCalculator;
