const libAssert = require('node:assert/strict');

const libFS = require('fs');
const libPath = require('path');
const libOS = require('os');
const libChildProcess = require('child_process');

const libPict = require('pict');
const libManyfest = require('manyfest');
const libPDFFormFiller = require('../source/services/Service-PDFFormFiller.js');
const libPDFFormCalculator = require('../source/services/Service-PDFFormCalculator.js');
const libConversionReport = require('../source/services/Service-ConversionReport.js');

// Self-contained: uses the committed 1907J fixture + an inline mapping, so this exercises the whole
// fill-with-calculations pipeline (resolve inputs -> run the form's own JS -> pdftk) on any machine
// with pdftk, and skips cleanly where pdftk is not installed.
const TEMPLATE_1907J = libPath.join(__dirname, 'fixtures', '1907J.pdf');

const pdftkAvailable = () =>
{
	for (const tmpBinary of ['pdftk', 'pdftk-java'])
	{
		try
		{
			const tmpResult = libChildProcess.spawnSync('which', [tmpBinary], { encoding: 'utf8' });
			if (tmpResult.status === 0 && tmpResult.stdout && tmpResult.stdout.trim()) { return tmpBinary; }
		}
		catch (pError) { /* try next */ }
	}
	return null;
};

const dumpFieldValue = (pBinary, pPDFPath, pFieldName) =>
{
	const tmpResult = libChildProcess.spawnSync(pBinary, [pPDFPath, 'dump_data_fields'], { encoding: 'utf8' });
	if (tmpResult.status !== 0) { return null; }
	for (const tmpBlock of tmpResult.stdout.split('---'))
	{
		const tmpName = tmpBlock.match(/FieldName:\s*(.+)/);
		if (tmpName && tmpName[1].trim() === pFieldName)
		{
			const tmpValue = tmpBlock.match(/FieldValue:\s*(.*)/);
			return tmpValue ? tmpValue[1].trim() : '';
		}
	}
	return null;
};

suite
(
	'PDFFormFiller: fill-with-calculations end-to-end (needs pdftk + the 1907J fixture)',
	() =>
	{
		let _pdftk = null;

		suiteSetup(function()
		{
			_pdftk = pdftkAvailable();
			if (!_pdftk || !libFS.existsSync(TEMPLATE_1907J))
			{
				this.skip();
			}
		});

		test('fills only the inputs; the form computes, formats, and colors E/F/G/H/I like Acrobat',
			async function()
			{
				if (!_pdftk || !libFS.existsSync(TEMPLATE_1907J))
				{
					this.skip();
					return;
				}
				this.timeout(20000);

				const tmpFable = new libPict();
				tmpFable.addServiceType('PDFFormFiller', libPDFFormFiller);
				tmpFable.addServiceType('PDFFormCalculator', libPDFFormCalculator);
				tmpFable.addServiceType('ConversionReport', libConversionReport);

				const tmpFiller = tmpFable.instantiateServiceProvider('PDFFormFiller');
				const tmpCalculator = tmpFable.instantiateServiceProvider('PDFFormCalculator');
				const tmpReporter = tmpFable.instantiateServiceProvider('ConversionReport');

				// Map ONLY the input cells (core 1 weights + the two 1911 Gmm cells); the form's own
				// JavaScript computes E/F/G/H/I from them.
				const tmpManyfest = new libManyfest();
				tmpManyfest.loadManifest(
					{
						Scope: '1907J',
						Descriptors:
							{
								'Aw1': { TargetFieldName: 'A WEIGHT OF CORE in water g_1' },
								'Bw1': { TargetFieldName: 'B WEIGHT OF CORE surface dry g_1' },
								'Cw1': { TargetFieldName: 'C WEIGHT OF CORE  PAN oven dryg_1' },
								'Dw1': { TargetFieldName: 'D WEIGHT OF PAN g_1' },
								'Gmm1a': { TargetFieldName: 'fill_8' },
								'Gmm1b': { TargetFieldName: 'fill_15' }
							}
					});
				tmpManyfest.manifest = tmpManyfest.manifest || {};
				tmpManyfest.manifest.SourceRootAddress = 'Data';

				const tmpSource = { Data: { Aw1: '649', Bw1: '1147', Cw1: '1136', Dw1: '7', Gmm1a: '2.422', Gmm1b: '2.422' } };

				const tmpTempDir = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'mfconv-calc-e2e-'));
				const tmpOutputPath = libPath.join(tmpTempDir, 'filled-1907J.pdf');
				const tmpReport = tmpReporter.newReport('src', '1907J.pdf', tmpManyfest);

				try
				{
					await tmpFiller.fillPDFWithCalculations(tmpManyfest, tmpSource, TEMPLATE_1907J, tmpOutputPath, tmpReport, tmpReporter, tmpCalculator, { Calculate: true });
					libAssert.equal(libFS.existsSync(tmpOutputPath), true);

					// Values come out computed AND formatted, exactly as Acrobat's calculate + format scripts produce.
					libAssert.equal(dumpFieldValue(_pdftk, tmpOutputPath, 'E DRY WEIGHT OF CORE C  D g_1'), '1,129.0');
					libAssert.equal(dumpFieldValue(_pdftk, tmpOutputPath, 'F VOLUME OF CORE B  A cc_1'), '498.0');
					libAssert.equal(dumpFieldValue(_pdftk, tmpOutputPath, 'G CORE SPECIFIC GRAVITY E  F_1'), '2.267');
					libAssert.equal(dumpFieldValue(_pdftk, tmpOutputPath, 'H AVG Gmm VALUE_1'), '2.422');
					libAssert.equal(dumpFieldValue(_pdftk, tmpOutputPath, 'I  CORE COMPACTION G  H 100_1'), '93.60');

					// I is in-spec (93.60 >= 86), so the form's own validate script colors it black --
					// overriding the stale red baked into the template's /DA.
					const libPDFLib = require('pdf-lib');
					const tmpOutDoc = await libPDFLib.PDFDocument.load(libFS.readFileSync(tmpOutputPath), { updateMetadata: false });
					const tmpIField = tmpOutDoc.getForm().getField('I  CORE COMPACTION G  H 100_1');
					const tmpDAObj = tmpIField.acroField.dict.get(libPDFLib.PDFName.of('DA'));
					const tmpDA = (typeof(tmpDAObj.decodeText) === 'function') ? tmpDAObj.decodeText() : tmpDAObj.asString();
					libAssert.ok(/\b0 g\b/.test(tmpDA), `I /DA should be black (0 g), got: ${tmpDA}`);
					libAssert.ok(!/1 0 0 rg/.test(tmpDA), 'I /DA should no longer be red');
				}
				finally
				{
					try { libFS.unlinkSync(tmpOutputPath); } catch (pError) { /* ignore */ }
					try { libFS.rmdirSync(tmpTempDir); } catch (pError) { /* ignore */ }
				}
			});
	}
);
