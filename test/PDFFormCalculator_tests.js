const libAssert = require('node:assert/strict');

const libFS = require('fs');
const libPath = require('path');

const libPict = require('pict');
const libPDFFormCalculator = require('../source/services/Service-PDFFormCalculator.js');

const TEMPLATE_1907J = libPath.join(__dirname, 'fixtures', '1907J.pdf');

const buildCalculator = () =>
{
	const tmpFable = new libPict();
	tmpFable.addServiceType('PDFFormCalculator', libPDFFormCalculator);
	return tmpFable.instantiateServiceProvider('PDFFormCalculator');
};

// A synthetic model mirroring the MDOT 1907J calc-script patterns: arithmetic (E/F/G/I),
// an averaging IIFE that uses `this.getField` (H), and an AFSimple_Calculate SUM (LEN).
const syntheticModel = () => (
	{
		Order: ['E', 'F', 'G', 'H', 'I', 'LEN'],
		Scripts:
			{
				'E': 'var n=+getField("C").value; var d=+getField("D").value; if(n!==0){event.value=n-d;}else{event.value="";}',
				'F': 'var n=+getField("B").value; var d=+getField("A").value; if(n!==0){event.value=n-d;}else{event.value="";}',
				'G': 'var n=+getField("E").value; var d=+getField("F").value; if(n!==0){value=n/d;event.value=Math.round(value*1000)/1000;}else{event.value="";}',
				'H': '(function(){var f=["g1","g2"];var s=0,c=0;for(var i=0;i<f.length;i++){var r=this.getField(f[i]).value;if(r!==""&&!isNaN(r)){s+=Number(r);c++;}}var a=c>0?s/c:0;event.value=Math.round(a*1000)/1000;})();',
				'I': 'var n=+getField("G").value; var d=+getField("H").value; if(d!==0){value=(n/d)*100;event.value=Math.round(value*100)/100;}else{event.value="";}',
				'LEN': 'AFSimple_Calculate("SUM", new Array("s1","s2","s3"));'
			}
	});

suite
(
	'PDFFormCalculator: runCalculations (Acrobat-shim, pure)',
	() =>
	{
		test('computes E=C-D, F=B-A, G=E/F(3dp), H=avg(3dp), I=G/H*100(2dp), and AFSimple SUM',
			() =>
			{
				const tmpCalc = buildCalculator();
				const tmpResult = tmpCalc.runCalculations(syntheticModel(),
					{ A: '649', B: '1147', C: '1136', D: '7', g1: '2.422', g2: '2.422', s1: '2000', s2: '2000', s3: '2000' });

				libAssert.equal(tmpResult.Values['E'], 1129);
				libAssert.equal(tmpResult.Values['F'], 498);
				libAssert.equal(tmpResult.Values['G'], 2.267);
				libAssert.equal(tmpResult.Values['H'], 2.422);
				libAssert.equal(tmpResult.Values['I'], 93.6);
				libAssert.equal(tmpResult.Values['LEN'], 6000);
			});

		test('blanks a derived cell when its numerator input is empty (like Acrobat)',
			() =>
			{
				const tmpCalc = buildCalculator();
				const tmpResult = tmpCalc.runCalculations(syntheticModel(), { A: '', B: '', C: '', D: '' });

				libAssert.equal(tmpResult.Values['E'], '');
				libAssert.equal(tmpResult.Values['F'], '');
			});

		test('only returns fields that carry a calc script (never touches inputs)',
			() =>
			{
				const tmpCalc = buildCalculator();
				const tmpResult = tmpCalc.runCalculations(syntheticModel(),
					{ A: '649', B: '1147', C: '1136', D: '7', g1: '2.422', g2: '2.422', s1: '2000', s2: '2000', s3: '2000' });

				libAssert.equal(Object.prototype.hasOwnProperty.call(tmpResult.Values, 'A'), false);
				libAssert.equal(Object.prototype.hasOwnProperty.call(tmpResult.Values, 'C'), false);
			});

		test('a field whose script throws is skipped, not wrongly computed',
			() =>
			{
				const tmpCalc = buildCalculator();
				const tmpResult = tmpCalc.runCalculations(
					{ Order: ['X'], Scripts: { 'X': 'event.value = definitely_not_a_defined_function();' } }, {});

				libAssert.equal(Object.prototype.hasOwnProperty.call(tmpResult.Values, 'X'), false);
				libAssert.equal(tmpResult.Skipped.length, 1);
				libAssert.equal(tmpResult.Skipped[0].Field, 'X');
			});
	}
);

suite
(
	'PDFFormCalculator: real 1907J extraction + calc (skipped if fixture missing)',
	() =>
	{
		test('extracts the /CO calc chain and computes core-1 math from filled inputs',
			async function()
			{
				if (!libFS.existsSync(TEMPLATE_1907J))
				{
					this.skip();
					return;
				}

				const tmpCalc = buildCalculator();
				const tmpModel = await tmpCalc.extractCalcModel(libFS.readFileSync(TEMPLATE_1907J));

				// 1907J has a 39-entry calculation chain.
				libAssert.ok(Object.keys(tmpModel.Scripts).length >= 30, 'expected the calc scripts to be extracted');
				libAssert.ok(tmpModel.Order.length >= 30, 'expected the /CO order to be extracted');

				const tmpResult = tmpCalc.runCalculations(tmpModel,
					{
						'A WEIGHT OF CORE in water g_1': '649',
						'B WEIGHT OF CORE surface dry g_1': '1147',
						'C WEIGHT OF CORE  PAN oven dryg_1': '1136',
						'D WEIGHT OF PAN g_1': '7',
						'fill_8': '2.422',
						'fill_15': '2.422'
					});

				libAssert.equal(tmpResult.Values['E DRY WEIGHT OF CORE C  D g_1'], 1129);
				libAssert.equal(tmpResult.Values['F VOLUME OF CORE B  A cc_1'], 498);
				libAssert.equal(tmpResult.Values['G CORE SPECIFIC GRAVITY E  F_1'], 2.267);
				libAssert.equal(tmpResult.Values['H AVG Gmm VALUE_1'], 2.422);
				libAssert.equal(tmpResult.Values['I  CORE COMPACTION G  H 100_1'], 93.6);
			});
	}
);

suite
(
	'PDFFormCalculator: ported Acrobat Forms API surface (no per-form hacking)',
	() =>
	{
		test('AFSimple_Calculate AVG / PRD / MIN / MAX',
			() =>
			{
				const tmpResult = buildCalculator().runCalculations(
					{
						Order: ['avg', 'prd', 'min', 'max'],
						Scripts:
							{
								avg: 'AFSimple_Calculate("AVG", new Array("a","b","c"));',
								prd: 'AFSimple_Calculate("PRD", new Array("a","b","c"));',
								min: 'AFSimple_Calculate("MIN", new Array("a","b","c"));',
								max: 'AFSimple_Calculate("MAX", new Array("a","b","c"));'
							}
					},
					{ a: '2', b: '3', c: '4' });
				libAssert.equal(tmpResult.Values.avg, 3);
				libAssert.equal(tmpResult.Values.prd, 24);
				libAssert.equal(tmpResult.Values.min, 2);
				libAssert.equal(tmpResult.Values.max, 4);
			});

		test('util.printf is available to scripts',
			() =>
			{
				const tmpResult = buildCalculator().runCalculations(
					{ Order: ['p'], Scripts: { p: 'event.value = util.printf("%.2f", 3.14159);' } }, {});
				libAssert.equal(tmpResult.Values.p, '3.14');
			});

		test('AFNumber_Format formats event.value like Acrobat (thousands + 2dp)',
			() =>
			{
				const tmpResult = buildCalculator().runCalculations(
					{ Order: ['n'], Scripts: { n: 'event.value = 12345.6; AFNumber_Format(2, 0, 0, 0, "", false);' } }, {});
				libAssert.equal(tmpResult.Values.n, '12,345.60');
			});

		test('a document-level helper function is available to field scripts',
			() =>
			{
				const tmpResult = buildCalculator().runCalculations(
					{
						Order: ['t'],
						Scripts: { t: 'event.value = triple(getField("x").value);' },
						DocScripts: [ 'function triple(v){ return Number(v) * 3; }' ]
					},
					{ x: '7' });
				libAssert.equal(tmpResult.Values.t, 21);
			});

		test('event.target and this.getField resolve inside a calc script',
			() =>
			{
				const tmpResult = buildCalculator().runCalculations(
					{ Order: ['e'], Scripts: { e: 'event.value = event.target.name + ":" + this.getField("q").value;' } },
					{ q: '42' });
				libAssert.equal(tmpResult.Values.e, 'e:42');
			});
	}
);

suite
(
	'PDFFormCalculator: format + validate (display + color)',
	() =>
	{
		const validateColorScript = 'if (Number(event.value) < 86) { event.target.textColor = color.red; } else { event.target.textColor = color.black; }';

		test('format script produces the Acrobat display string; it does not change the stored value',
			() =>
			{
				const tmpCalc = buildCalculator();
				const tmpResult = tmpCalc.runFormatAndValidate(
					{ Order: ['n'], FormatScripts: { n: 'AFNumber_Format(2, 0, 0, 0, "", false);' } },
					{ n: '1234.5' });
				libAssert.equal(tmpResult.DisplayValues.n, '1,234.50');
			});

		test('validate script sets black for an in-spec value and red for out-of-spec',
			() =>
			{
				const tmpCalc = buildCalculator();
				const tmpIn = tmpCalc.runFormatAndValidate(
					{ Order: ['f'], ValidateScripts: { f: validateColorScript } }, { f: '93.6' });
				libAssert.deepEqual(tmpIn.Colors.f, ['G', 0]);          // black

				const tmpOut = tmpCalc.runFormatAndValidate(
					{ Order: ['f'], ValidateScripts: { f: validateColorScript } }, { f: '50' });
				libAssert.deepEqual(tmpOut.Colors.f, ['RGB', 1, 0, 0]); // red
			});

		test('a field whose validate script does not touch color is not recolored',
			() =>
			{
				const tmpCalc = buildCalculator();
				const tmpResult = tmpCalc.runFormatAndValidate(
					{ Order: ['x'], ValidateScripts: { x: 'event.rc = true;' } }, { x: '5' });
				libAssert.equal(Object.prototype.hasOwnProperty.call(tmpResult.Colors, 'x'), false);
			});

		test('_colorOperator maps Acrobat color arrays to PDF /DA operators',
			() =>
			{
				const tmpCalc = buildCalculator();
				libAssert.equal(tmpCalc._colorOperator(['G', 0]), '0 g');
				libAssert.equal(tmpCalc._colorOperator(['RGB', 1, 0, 0]), '1 0 0 rg');
				libAssert.equal(tmpCalc._colorOperator(['CMYK', 0, 0, 0, 1]), '0 0 0 1 k');
				libAssert.equal(tmpCalc._colorOperator(['T']), null);
			});
	}
);
