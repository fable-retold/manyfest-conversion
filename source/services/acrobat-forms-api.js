/*
 * Acrobat Forms JavaScript API — for running an AcroForm's own calculation/format/validate scripts
 * outside Acrobat so derived cells compute "like Acrobat".
 *
 * The AForm / Util / Color classes and the printf/printd/printx/scand algorithms are PORTED from
 * Mozilla pdf.js `src/scripting_api` and `src/shared/scripting_utils.js`
 * (https://github.com/mozilla/pdf.js), Copyright 2020 Mozilla Foundation, licensed under the
 * Apache License 2.0. They are adapted here to CommonJS / Node 20 (no `Map.getOrInsertComputed`, no
 * `Math.sumPrecise`, no ESM/PDFObject internals) and rewired so `globalThis.event` becomes a shared
 * event object, because the API runs host-side while the form's own scripts run in a Node `vm`
 * sandbox. The lightweight Doc / Field / Event / App adapters over a flat field-value model are new.
 *
 * @license Apache-2.0 (ported portions), MIT (adapters) — see NOTICE in the module docstring above.
 */

// ── small helpers (ported) ──────────────────────────────────────────────────

function MathClamp(value, min, max)
{
	return Math.min(Math.max(value, min), max);
}

function sumPrecise(values)
{
	// Math.sumPrecise is Node 22+; fall back to a plain sum on Node 20.
	if (typeof Math.sumPrecise === 'function')
	{
		return Math.sumPrecise(values);
	}
	let tmpSum = 0;
	for (let i = 0; i < values.length; i++) { tmpSum += values[i]; }
	return tmpSum;
}

const DateFormats = [
	'm/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy',
	'yy-mm-dd', 'mmm-yy', 'mmmm-yy', 'mmm d, yyyy', 'mmmm d, yyyy',
	'm/d/yy h:MM tt', 'm/d/yy HH:MM'
];
const TimeFormats = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];

// Only the strings AForm interpolates into app.alert() validation messages.
const GlobalConstants = {
	IDS_INVALID_VALUE: 'The value entered does not match the format of the field',
	IDS_INVALID_DATE: 'Invalid date/time:',
	IDS_INVALID_DATE2: ' please ensure that the date/time exists. Field',
	IDS_GT_AND_LT: 'The value must be greater than or equal to %s and less than or equal to %s',
	IDS_GREATER_THAN: 'The value must be greater than or equal to %s',
	IDS_LESS_THAN: 'The value must be less than or equal to %s'
};

function scaleAndClamp(x) { return MathClamp(x, 0, 1) * 255; }

// PDF spec §10.3 color-space conversions (ported).
const ColorConverters = {
	CMYK_G(a) { const c = a[0], y = a[1], m = a[2], k = a[3]; return ['G', 1 - Math.min(1, 0.3 * c + 0.59 * m + 0.11 * y + k)]; },
	G_CMYK(a) { return ['CMYK', 0, 0, 0, 1 - a[0]]; },
	G_RGB(a) { const g = a[0]; return ['RGB', g, g, g]; },
	RGB_G(a) { return ['G', 0.3 * a[0] + 0.59 * a[1] + 0.11 * a[2]]; },
	CMYK_RGB(a) { const c = a[0], y = a[1], m = a[2], k = a[3]; return ['RGB', 1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)]; },
	RGB_CMYK(a) { const r = a[0], g = a[1], b = a[2]; const c = 1 - r, m = 1 - g, y = 1 - b; return ['CMYK', c, m, y, Math.min(c, m, y)]; }
};

// ── Color (ported from pdf.js color.js) ─────────────────────────────────────

class Color
{
	constructor()
	{
		this.transparent = ['T'];
		this.black = ['G', 0];
		this.white = ['G', 1];
		this.red = ['RGB', 1, 0, 0];
		this.green = ['RGB', 0, 1, 0];
		this.blue = ['RGB', 0, 0, 1];
		this.cyan = ['CMYK', 1, 0, 0, 0];
		this.magenta = ['CMYK', 0, 1, 0, 0];
		this.yellow = ['CMYK', 0, 0, 1, 0];
		this.dkGray = ['G', 0.25];
		this.gray = ['G', 0.5];
		this.ltGray = ['G', 0.75];
	}

	static _isValidSpace(cColorSpace)
	{
		return typeof cColorSpace === 'string' && (cColorSpace === 'T' || cColorSpace === 'G' || cColorSpace === 'RGB' || cColorSpace === 'CMYK');
	}

	static _isValidColor(colorArray)
	{
		if (!Array.isArray(colorArray) || colorArray.length === 0) { return false; }
		const tmpSpace = colorArray[0];
		if (!Color._isValidSpace(tmpSpace)) { return false; }
		const tmpLen = { T: 1, G: 2, RGB: 4, CMYK: 5 }[tmpSpace];
		if (colorArray.length !== tmpLen) { return false; }
		return colorArray.slice(1).every((c) => typeof c === 'number' && c >= 0 && c <= 1);
	}

	static _getCorrectColor(colorArray) { return Color._isValidColor(colorArray) ? colorArray : ['G', 0]; }

	convert(colorArray, cColorSpace)
	{
		if (!Color._isValidSpace(cColorSpace)) { return this.black; }
		if (cColorSpace === 'T') { return ['T']; }
		colorArray = Color._getCorrectColor(colorArray);
		if (colorArray[0] === cColorSpace) { return colorArray; }
		if (colorArray[0] === 'T') { return this.convert(this.black, cColorSpace); }
		const tmpConverter = ColorConverters[`${colorArray[0]}_${cColorSpace}`];
		return tmpConverter ? tmpConverter(colorArray.slice(1)) : this.black;
	}

	equal(colorArray1, colorArray2)
	{
		colorArray1 = Color._getCorrectColor(colorArray1);
		colorArray2 = Color._getCorrectColor(colorArray2);
		if (colorArray1[0] === 'T' || colorArray2[0] === 'T') { return colorArray1[0] === 'T' && colorArray2[0] === 'T'; }
		if (colorArray1[0] !== colorArray2[0]) { colorArray2 = this.convert(colorArray2, colorArray1[0]); }
		return colorArray1.slice(1).every((c, i) => c === colorArray2[i + 1]);
	}
}

// ── Util (ported from pdf.js util.js; caches dropped for Node-20 portability) ─

class Util
{
	constructor()
	{
		this._months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
		this._days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		this.MILLISECONDS_IN_DAY = 86400000;
		this.MILLISECONDS_IN_WEEK = 604800000;
	}

	printf(...args)
	{
		if (args.length === 0) { throw new Error('Invalid number of params in printf'); }
		if (typeof args[0] !== 'string') { throw new TypeError('First argument of printf must be a string'); }

		const pattern = /%(,[0-4])?([+ 0#]+)?(\d+)?(\.\d+)?(.)/g;
		const PLUS = 1, SPACE = 2, ZERO = 4, HASH = 8;
		let i = 0;
		return args[0].replaceAll(pattern, function (_, nDecSep, cFlags, nWidth, nPrecision, cConvChar)
		{
			if (cConvChar !== 'd' && cConvChar !== 'f' && cConvChar !== 's' && cConvChar !== 'x')
			{
				const tmpBuf = ['%'];
				for (const tmpStr of [nDecSep, cFlags, nWidth, nPrecision, cConvChar]) { if (tmpStr) { tmpBuf.push(tmpStr); } }
				return tmpBuf.join('');
			}
			i++;
			if (i === args.length) { throw new Error('Not enough arguments in printf'); }
			const arg = args[i];
			if (cConvChar === 's') { return arg.toString(); }

			let flags = 0;
			if (cFlags)
			{
				for (const flag of cFlags)
				{
					if (flag === '+') { flags |= PLUS; }
					else if (flag === ' ') { flags |= SPACE; }
					else if (flag === '0') { flags |= ZERO; }
					else if (flag === '#') { flags |= HASH; }
				}
			}
			cFlags = flags;
			nWidth = nWidth ? parseInt(nWidth, 10) : nWidth;

			let intPart = Math.trunc(arg);
			if (cConvChar === 'x')
			{
				let hex = Math.abs(intPart).toString(16).toUpperCase();
				if (nWidth !== undefined) { hex = hex.padStart(nWidth, cFlags & ZERO ? '0' : ' '); }
				if (cFlags & HASH) { hex = `0x${hex}`; }
				return hex;
			}

			nPrecision = nPrecision ? parseInt(nPrecision.substring(1), 10) : nPrecision;
			nDecSep = nDecSep ? nDecSep.substring(1) : '0';
			const separators = { 0: [',', '.'], 1: ['', '.'], 2: ['.', ','], 3: ['', ','], 4: ['\'', '.'] };
			const thousandSep = separators[nDecSep][0];
			const decimalSep = separators[nDecSep][1];

			let decPart = '';
			if (cConvChar === 'f')
			{
				decPart = nPrecision !== undefined ? Math.abs(arg - intPart).toFixed(nPrecision) : Math.abs(arg - intPart).toString();
				if (decPart.length > 2)
				{
					if (/^1\.0+$/.test(decPart)) { intPart += Math.sign(arg); decPart = `${decimalSep}${decPart.split('.')[1]}`; }
					else { decPart = `${decimalSep}${decPart.substring(2)}`; }
				}
				else
				{
					if (decPart === '1') { intPart += Math.sign(arg); }
					decPart = cFlags & HASH ? '.' : '';
				}
			}

			let sign = '';
			if (intPart < 0) { sign = '-'; intPart = -intPart; }
			else if (cFlags & PLUS) { sign = '+'; }
			else if (cFlags & SPACE) { sign = ' '; }

			if (thousandSep && intPart >= 1000)
			{
				const tmpBuf = [];
				for (;;)
				{
					tmpBuf.push((intPart % 1000).toString().padStart(3, '0'));
					intPart = Math.trunc(intPart / 1000);
					if (intPart < 1000) { tmpBuf.push(intPart.toString()); break; }
				}
				intPart = tmpBuf.reverse().join(thousandSep);
			}
			else { intPart = intPart.toString(); }

			let n = `${intPart}${decPart}`;
			if (nWidth !== undefined) { n = n.padStart(nWidth - sign.length, cFlags & ZERO ? '0' : ' '); }
			return `${sign}${n}`;
		});
	}

	iconStreamFromIcon() { /* not implemented */ }

	printd(cFormat, oDate)
	{
		if (cFormat === 0) { return this.printd('D:yyyymmddHHMMss', oDate); }
		if (cFormat === 1) { return this.printd('yyyy.mm.dd HH:MM:ss', oDate); }
		if (cFormat === 2) { return this.printd('m/d/yy h:MM:ss tt', oDate); }

		const tmpMonths = this._months, tmpDays = this._days;
		const handlers = {
			mmmm: (d) => tmpMonths[d.month],
			mmm: (d) => tmpMonths[d.month].substring(0, 3),
			mm: (d) => (d.month + 1).toString().padStart(2, '0'),
			m: (d) => (d.month + 1).toString(),
			dddd: (d) => tmpDays[d.dayOfWeek],
			ddd: (d) => tmpDays[d.dayOfWeek].substring(0, 3),
			dd: (d) => d.day.toString().padStart(2, '0'),
			d: (d) => d.day.toString(),
			yyyy: (d) => d.year.toString().padStart(4, '0'),
			yy: (d) => (d.year % 100).toString().padStart(2, '0'),
			HH: (d) => d.hours.toString().padStart(2, '0'),
			H: (d) => d.hours.toString(),
			hh: (d) => (1 + ((d.hours + 11) % 12)).toString().padStart(2, '0'),
			h: (d) => (1 + ((d.hours + 11) % 12)).toString(),
			MM: (d) => d.minutes.toString().padStart(2, '0'),
			M: (d) => d.minutes.toString(),
			ss: (d) => d.seconds.toString().padStart(2, '0'),
			s: (d) => d.seconds.toString(),
			tt: (d) => (d.hours < 12 ? 'am' : 'pm'),
			t: (d) => (d.hours < 12 ? 'a' : 'p')
		};
		const data = {
			year: oDate.getFullYear(), month: oDate.getMonth(), day: oDate.getDate(), dayOfWeek: oDate.getDay(),
			hours: oDate.getHours(), minutes: oDate.getMinutes(), seconds: oDate.getSeconds()
		};
		const patterns = /(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t|\\.)/g;
		return cFormat.replaceAll(patterns, (_, pattern) => (pattern in handlers ? handlers[pattern](data) : pattern.charCodeAt(1)));
	}

	printx(cFormat, cSource)
	{
		cSource = (cSource == null ? '' : cSource).toString();
		const handlers = [(x) => x, (x) => x.toUpperCase(), (x) => x.toLowerCase()];
		const buf = [];
		let i = 0;
		const ii = cSource.length;
		let currCase = handlers[0];
		let escaped = false;
		for (const command of cFormat)
		{
			if (escaped) { buf.push(command); escaped = false; continue; }
			if (i >= ii) { break; }
			switch (command)
			{
				case '?': buf.push(currCase(cSource.charAt(i++))); break;
				case 'X': while (i < ii) { const c = cSource.charAt(i++); if (('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z') || ('0' <= c && c <= '9')) { buf.push(currCase(c)); break; } } break;
				case 'A': while (i < ii) { const c = cSource.charAt(i++); if (('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')) { buf.push(currCase(c)); break; } } break;
				case '9': while (i < ii) { const c = cSource.charAt(i++); if ('0' <= c && c <= '9') { buf.push(c); break; } } break;
				case '*': while (i < ii) { buf.push(currCase(cSource.charAt(i++))); } break;
				case '\\': escaped = true; break;
				case '>': currCase = handlers[1]; break;
				case '<': currCase = handlers[2]; break;
				case '=': currCase = handlers[0]; break;
				default: buf.push(command);
			}
		}
		return buf.join('');
	}

	_createDateActions(cFormat)
	{
		const actions = [];
		cFormat.replaceAll(/(d+)|(m+)|(y+)|(H+)|(M+)|(s+)/g, function (_, d, m, y, H, M, s)
		{
			if (d) { actions.push((n, data) => { if (n >= 1 && n <= 31) { data.day = n; return true; } return false; }); }
			else if (m) { actions.push((n, data) => { if (n >= 1 && n <= 12) { data.month = n - 1; return true; } return false; }); }
			else if (y) { actions.push((n, data) => { if (n < 50) { n += 2000; } else if (n < 100) { n += 1900; } data.year = n; return true; }); }
			else if (H) { actions.push((n, data) => { if (n >= 0 && n <= 23) { data.hours = n; return true; } return false; }); }
			else if (M) { actions.push((n, data) => { if (n >= 0 && n <= 59) { data.minutes = n; return true; } return false; }); }
			else if (s) { actions.push((n, data) => { if (n >= 0 && n <= 59) { data.seconds = n; return true; } return false; }); }
			return '';
		});
		return actions;
	}

	_tryToGuessDate(cFormat, cDate)
	{
		const actions = this._createDateActions(cFormat);
		const number = /\d+/g;
		let i = 0, array;
		const data = { year: new Date().getFullYear(), month: 0, day: 1, hours: 12, minutes: 0, seconds: 0 };
		while ((array = number.exec(cDate)) !== null)
		{
			if (i < actions.length) { if (!actions[i++](parseInt(array[0], 10), data)) { return null; } }
			else { break; }
		}
		if (i === 0) { return null; }
		return new Date(data.year, data.month, data.day, data.hours, data.minutes, data.seconds);
	}

	scand(cFormat, cDate) { return this._scand(cFormat, cDate); }

	_createScandData(cFormat)
	{
		const months = this._months, days = this._days;
		const handlers = {
			mmmm: { pattern: `(${months.join('|')})`, action: (v, d) => { d.month = months.indexOf(v); } },
			mmm: { pattern: `(${months.map((m) => m.substring(0, 3)).join('|')})`, action: (v, d) => { d.month = months.findIndex((m) => m.substring(0, 3) === v); } },
			mm: { pattern: '(\\d{2})', action: (v, d) => { d.month = parseInt(v, 10) - 1; } },
			m: { pattern: '(\\d{1,2})', action: (v, d) => { d.month = parseInt(v, 10) - 1; } },
			dddd: { pattern: `(${days.join('|')})`, action: (v, d) => { d.day = days.indexOf(v); } },
			ddd: { pattern: `(${days.map((x) => x.substring(0, 3)).join('|')})`, action: (v, d) => { d.day = days.findIndex((x) => x.substring(0, 3) === v); } },
			dd: { pattern: '(\\d{2})', action: (v, d) => { d.day = parseInt(v, 10); } },
			d: { pattern: '(\\d{1,2})', action: (v, d) => { d.day = parseInt(v, 10); } },
			yyyy: { pattern: '(\\d{4})', action: (v, d) => { d.year = parseInt(v, 10); } },
			yy: { pattern: '(\\d{2})', action: (v, d) => { d.year = 2000 + parseInt(v, 10); } },
			HH: { pattern: '(\\d{2})', action: (v, d) => { d.hours = parseInt(v, 10); } },
			H: { pattern: '(\\d{1,2})', action: (v, d) => { d.hours = parseInt(v, 10); } },
			hh: { pattern: '(\\d{2})', action: (v, d) => { d.hours = parseInt(v, 10); } },
			h: { pattern: '(\\d{1,2})', action: (v, d) => { d.hours = parseInt(v, 10); } },
			MM: { pattern: '(\\d{2})', action: (v, d) => { d.minutes = parseInt(v, 10); } },
			M: { pattern: '(\\d{1,2})', action: (v, d) => { d.minutes = parseInt(v, 10); } },
			ss: { pattern: '(\\d{2})', action: (v, d) => { d.seconds = parseInt(v, 10); } },
			s: { pattern: '(\\d{1,2})', action: (v, d) => { d.seconds = parseInt(v, 10); } },
			tt: { pattern: '([aApP][mM])', action: (v, d) => { const c = v.charAt(0); d.am = c === 'a' || c === 'A'; } },
			t: { pattern: '([aApP])', action: (v, d) => { d.am = v === 'a' || v === 'A'; } }
		};
		const escapedFormat = cFormat.replaceAll(/[.*+\-?^${}()|[\]\\]/g, '\\$&');
		const patterns = /(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t)/g;
		const actions = [];
		const re = escapedFormat.replaceAll(patterns, function (_, patternElement)
		{
			const h = handlers[patternElement];
			actions.push(h.action);
			return h.pattern;
		});
		return [new RegExp(`^${re}$`, 'g'), actions];
	}

	_scand(cFormat, cDate, strict)
	{
		strict = strict || false;
		if (typeof cDate !== 'string') { return new Date(cDate); }
		if (cDate === '') { return new Date(); }
		if (cFormat === 0) { return this.scand('D:yyyymmddHHMMss', cDate); }
		if (cFormat === 1) { return this.scand('yyyy.mm.dd HH:MM:ss', cDate); }
		if (cFormat === 2) { return this.scand('m/d/yy h:MM:ss tt', cDate); }

		const built = this._createScandData(cFormat);
		const regex = built[0], actions = built[1];
		const matches = regex.exec(cDate);
		if (!matches || matches.length !== actions.length + 1) { return strict ? null : this._tryToGuessDate(cFormat, cDate); }
		const data = { year: 2000, month: 0, day: 1, hours: 0, minutes: 0, seconds: 0, am: null };
		actions.forEach((action, i) => action(matches[i + 1], data));
		if (data.am !== null) { data.hours = (data.hours % 12) + (data.am ? 0 : 12); }
		return new Date(data.year, data.month, data.day, data.hours, data.minutes, data.seconds);
	}
}

// ── AForm (ported from pdf.js aform.js; globalThis.event -> this._getEvent()) ─

class AForm
{
	constructor(document, app, util, color, getEvent)
	{
		this._document = document;
		this._app = app;
		this._util = util;
		this._color = color;
		this._getEvent = getEvent;
		this._emailRegex = new RegExp(
			'^[\\w.!#$%&\'*+/=?^`{|}~-]+' +
			'@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?' +
			'(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$');
	}

	_mkTargetName(event) { return event.target ? `[ ${event.target.name} ]` : ''; }

	_parseDate(cFormat, cDate)
	{
		let date = null;
		try { date = this._util._scand(cFormat, cDate, false); } catch (pError) { /* ignore */ }
		if (date) { return date; }
		date = Date.parse(cDate);
		return isNaN(date) ? null : new Date(date);
	}

	AFMergeChange(event)
	{
		event = event || this._getEvent();
		return event.willCommit ? (event.value == null ? '' : event.value.toString()) : this._app._eventDispatcher.mergeChange(event);
	}

	AFParseDateEx(cString, cOrder) { return this._parseDate(cOrder, cString); }

	AFExtractNums(str)
	{
		if (typeof str === 'number') { return [str]; }
		if (!str || typeof str !== 'string') { return null; }
		const first = str.charAt(0);
		if (first === '.' || first === ',') { str = `0${str}`; }
		const numbers = str.match(/(\d+)/g);
		if (!numbers || numbers.length === 0) { return null; }
		return numbers;
	}

	AFMakeNumber(str)
	{
		if (typeof str === 'number') { return str; }
		if (typeof str !== 'string') { return null; }
		str = str.trim().replace(',', '.');
		const number = parseFloat(str);
		if (isNaN(number) || !isFinite(number)) { return null; }
		return number;
	}

	AFMakeArrayFromList(string) { return typeof string === 'string' ? string.split(/, ?/g) : string; }

	AFNumber_Format(nDec, sepStyle, negStyle, currStyle, strCurrency, bCurrencyPrepend)
	{
		const event = this._getEvent();
		let value = this.AFMakeNumber(event.value);
		if (value === null) { event.value = ''; return; }
		const sign = Math.sign(value);
		const buf = [];
		let hasParen = false;
		if (sign === -1 && bCurrencyPrepend && negStyle === 0) { buf.push('-'); }
		if ((negStyle === 2 || negStyle === 3) && sign === -1) { buf.push('('); hasParen = true; }
		if (bCurrencyPrepend) { buf.push(strCurrency); }
		sepStyle = MathClamp(Math.floor(sepStyle), 0, 4);
		buf.push('%,', sepStyle, '.', nDec.toString(), 'f');
		if (!bCurrencyPrepend) { buf.push(strCurrency); }
		if (hasParen) { buf.push(')'); }
		if (negStyle === 1 || negStyle === 3) { if (event.target) { event.target.textColor = sign === 1 ? this._color.black : this._color.red; } }
		if ((negStyle !== 0 || bCurrencyPrepend) && sign === -1) { value = -value; }
		event.value = this._util.printf(buf.join(''), value);
	}

	AFNumber_Keystroke(nDec, sepStyle, negStyle, currStyle, strCurrency, bCurrencyPrepend)
	{
		const event = this._getEvent();
		let value = this.AFMergeChange(event);
		if (!value) { return; }
		value = value.trim();
		let pattern;
		if (sepStyle > 1) { pattern = event.willCommit ? /^[+-]?(\d+(,\d*)?|,\d+)$/ : /^[+-]?\d*(?:,\d*)?$/; }
		else { pattern = event.willCommit ? /^[+-]?(\d+(\.\d*)?|\.\d+)$/ : /^[+-]?\d*(?:\.\d*)?$/; }
		if (!pattern.test(value))
		{
			if (event.willCommit) { this._app.alert(`${GlobalConstants.IDS_INVALID_VALUE} ${this._mkTargetName(event)}`); }
			event.rc = false;
		}
		if (event.willCommit && sepStyle > 1) { event.value = parseFloat(value.replace(',', '.')); }
	}

	AFPercent_Format(nDec, sepStyle, percentPrepend)
	{
		percentPrepend = percentPrepend || false;
		if (typeof nDec !== 'number') { return; }
		if (typeof sepStyle !== 'number') { return; }
		if (nDec < 0) { throw new Error('Invalid nDec value in AFPercent_Format'); }
		const event = this._getEvent();
		if (nDec > 512) { event.value = '%'; return; }
		nDec = Math.floor(nDec);
		sepStyle = MathClamp(Math.floor(sepStyle), 0, 4);
		let value = this.AFMakeNumber(event.value);
		if (value === null) { event.value = '%'; return; }
		value = this._util.printf(`%,${sepStyle}.${nDec}f`, value * 100);
		event.value = percentPrepend ? `%${value}` : `${value}%`;
	}

	AFPercent_Keystroke(nDec, sepStyle) { this.AFNumber_Keystroke(nDec, sepStyle, 0, 0, '', true); }

	AFDate_FormatEx(cFormat)
	{
		const event = this._getEvent();
		const value = event.value;
		if (!value) { return; }
		const date = this._parseDate(cFormat, value);
		if (date !== null) { event.value = this._util.printd(cFormat, date); }
	}

	AFDate_Format(pdf) { this.AFDate_FormatEx(DateFormats[pdf] != null ? DateFormats[pdf] : pdf); }

	AFDate_KeystrokeEx(cFormat)
	{
		const event = this._getEvent();
		if (!event.willCommit) { return; }
		const value = this.AFMergeChange(event);
		if (!value) { return; }
		if (this._parseDate(cFormat, value) === null)
		{
			this._app.alert(`${GlobalConstants.IDS_INVALID_DATE} ${this._mkTargetName(event)}${GlobalConstants.IDS_INVALID_DATE2}${cFormat}`);
			event.rc = false;
		}
	}

	AFDate_Keystroke(pdf) { if (pdf >= 0 && pdf < DateFormats.length) { this.AFDate_KeystrokeEx(DateFormats[pdf]); } }

	AFRange_Validate(bGreaterThan, nGreaterThan, bLessThan, nLessThan)
	{
		const event = this._getEvent();
		if (!event.value) { return; }
		const value = this.AFMakeNumber(event.value);
		if (value === null) { return; }
		bGreaterThan = !!bGreaterThan;
		bLessThan = !!bLessThan;
		if (bGreaterThan) { nGreaterThan = this.AFMakeNumber(nGreaterThan); if (nGreaterThan === null) { return; } }
		if (bLessThan) { nLessThan = this.AFMakeNumber(nLessThan); if (nLessThan === null) { return; } }
		let err = '';
		if (bGreaterThan && bLessThan) { if (value < nGreaterThan || value > nLessThan) { err = this._util.printf(GlobalConstants.IDS_GT_AND_LT, nGreaterThan, nLessThan); } }
		else if (bGreaterThan) { if (value < nGreaterThan) { err = this._util.printf(GlobalConstants.IDS_GREATER_THAN, nGreaterThan); } }
		else if (value > nLessThan) { err = this._util.printf(GlobalConstants.IDS_LESS_THAN, nLessThan); }
		if (err) { this._app.alert(err); event.rc = false; }
	}

	AFSimple(cFunction, nValue1, nValue2)
	{
		const value1 = this.AFMakeNumber(nValue1);
		if (value1 === null) { throw new Error('Invalid nValue1 in AFSimple'); }
		const value2 = this.AFMakeNumber(nValue2);
		if (value2 === null) { throw new Error('Invalid nValue2 in AFSimple'); }
		switch (cFunction)
		{
			case 'AVG': return (value1 + value2) / 2;
			case 'SUM': return value1 + value2;
			case 'PRD': return value1 * value2;
			case 'MIN': return Math.min(value1, value2);
			case 'MAX': return Math.max(value1, value2);
		}
		throw new Error('Invalid cFunction in AFSimple');
	}

	AFSimple_Calculate(cFunction, cFields)
	{
		const actions = {
			AVG: (args) => sumPrecise(args) / args.length,
			SUM: (args) => sumPrecise(args),
			PRD: (args) => args.reduce((acc, value) => acc * value, 1),
			MIN: (args) => Math.min.apply(null, args),
			MAX: (args) => Math.max.apply(null, args)
		};
		if (!(cFunction in actions)) { throw new TypeError('Invalid function in AFSimple_Calculate'); }
		const event = this._getEvent();
		const values = [];
		cFields = this.AFMakeArrayFromList(cFields);
		for (const cField of cFields)
		{
			const field = this._document.getField(cField);
			if (!field) { continue; }
			for (const child of field.getArray())
			{
				const number = this.AFMakeNumber(child.value);
				values.push(number == null ? 0 : number);
			}
		}
		if (values.length === 0) { event.value = 0; return; }
		const res = actions[cFunction](values);
		event.value = Math.round(1e6 * res) / 1e6;
	}

	AFSpecial_Format(psf)
	{
		const event = this._getEvent();
		if (!event.value) { return; }
		psf = this.AFMakeNumber(psf);
		let formatStr;
		switch (psf)
		{
			case 0: formatStr = '99999'; break;
			case 1: formatStr = '99999-9999'; break;
			case 2: formatStr = this._util.printx('9999999999', event.value).length >= 10 ? '(999) 999-9999' : '999-9999'; break;
			case 3: formatStr = '999-99-9999'; break;
			default: throw new Error('Invalid psf in AFSpecial_Format');
		}
		event.value = this._util.printx(formatStr, event.value);
	}

	AFTime_FormatEx(cFormat) { this.AFDate_FormatEx(cFormat); }
	AFTime_Format(pdf) { this.AFDate_FormatEx(TimeFormats[pdf] != null ? TimeFormats[pdf] : pdf); }
	AFTime_KeystrokeEx(cFormat) { this.AFDate_KeystrokeEx(cFormat); }
	AFTime_Keystroke(pdf) { if (pdf >= 0 && pdf < TimeFormats.length) { this.AFDate_KeystrokeEx(TimeFormats[pdf]); } }

	eMailValidate(str) { return this._emailRegex.test(str); }
}

// ── Lightweight Doc / Field / Event / App adapters over a flat value model ────

/**
 * @typedef {Object} FieldValueState
 * @property {function(string):boolean} has
 * @property {function(string):*} get
 * @property {function(string,*):void} set
 * @property {Array<string>} names
 */

class Field
{
	constructor(pState, pName)
	{
		this._state = pState;
		this.name = pName;
		this.readonly = false;
		this.hidden = false;
		this.display = 0;
		this.type = 'text';
		this._textColor = ['G', 0];
		this._textColorSet = false;
	}

	get value() { const tmpValue = this._state.get(this.name); return (tmpValue == null) ? '' : tmpValue; }
	set value(pValue) { this._state.set(this.name, pValue); }
	get valueAsString() { const tmpValue = this.value; return (tmpValue == null) ? '' : String(tmpValue); }
	set valueAsString(pValue) { this._state.set(this.name, pValue); }
	get textColor() { return this._textColor; }
	set textColor(pColor) { this._textColor = pColor; this._textColorSet = true; }

	getArray() { return [this]; }
	getItemAt() { return null; }
}

function buildDoc(pState, pFieldCache, pRecalcRef)
{
	const tmpDoc = {
		getField(pName)
		{
			if (pName == null) { return null; }
			const tmpName = String(pName);
			if (!pState.has(tmpName)) { return null; }
			let tmpField = pFieldCache[tmpName];
			if (!tmpField) { tmpField = new Field(pState, tmpName); pFieldCache[tmpName] = tmpField; }
			return tmpField;
		},
		getNthFieldName(pIndex) { return pState.names[pIndex] != null ? pState.names[pIndex] : null; },
		calculateNow() { if (typeof pRecalcRef.fn === 'function') { pRecalcRef.fn(); } },
		resetForm() { /* no-op */ },
		mailForm() { /* no-op */ },
		mailDoc() { /* no-op */ },
		print() { /* no-op */ },
		getPageNumWords() { return 0; },
		info: {},
		external: true,
		numPages: 1
	};
	Object.defineProperty(tmpDoc, 'numFields', { get() { return pState.names.length; } });
	return tmpDoc;
}

function buildApp(pWarnings)
{
	const tmpApp = {
		alert(pMessage) { pWarnings.push(typeof pMessage === 'object' && pMessage ? (pMessage.cMsg || '') : String(pMessage)); return 0; },
		beep() { /* no-op */ },
		launchURL() { /* no-op */ },
		response() { return null; },
		viewerVersion: 11,
		viewerType: 'Reader',
		platform: 'UNIX',
		language: 'ENU',
		_eventDispatcher: { mergeChange(pEvent) { return (pEvent && pEvent.change != null) ? pEvent.change : (pEvent && pEvent.value != null ? String(pEvent.value) : ''); } }
	};
	return tmpApp;
}

/**
 * Build a sandbox global object (Doc + Field + Event + App + Util + Color + AForm) over a flat
 * field-value model, ready to be used as the global of a Node `vm` context. Returns helpers to set
 * the "current event" (shared between host-side AForm and the in-vm scripts) and to read collected
 * validation warnings.
 *
 * @param {FieldValueState} pState
 * @param {{fn: Function}} pRecalcRef - mutable holder whose `.fn` runs a recalculation pass (for calculateNow()).
 * @returns {{ sandbox: object, setEvent: Function, warnings: Array<string> }}
 */
function buildSandbox(pState, pRecalcRef)
{
	const tmpWarnings = [];
	const tmpFieldCache = {};
	const tmpUtil = new Util();
	const tmpColor = new Color();
	const tmpApp = buildApp(tmpWarnings);
	const tmpDoc = buildDoc(pState, tmpFieldCache, pRecalcRef || { fn: null });

	const tmpEventHolder = { current: null };
	const tmpAForm = new AForm(tmpDoc, tmpApp, tmpUtil, tmpColor, () => tmpEventHolder.current);

	const tmpSandbox = {
		util: tmpUtil,
		color: tmpColor,
		app: tmpApp,
		global: Object.create(null),
		console: { println: () => {}, log: () => {}, clear: () => {}, show: () => {}, hide: () => {} },
		event: null
	};

	// Hoist AForm methods as globals (AFSimple_Calculate, AFNumber_Format, ...), like Acrobat/pdf.js.
	const tmpProto = Object.getOwnPropertyNames(Object.getPrototypeOf(tmpAForm));
	for (let i = 0; i < tmpProto.length; i++)
	{
		const tmpName = tmpProto[i];
		if (tmpName === 'constructor') { continue; }
		if (typeof tmpAForm[tmpName] === 'function') { tmpSandbox[tmpName] = tmpAForm[tmpName].bind(tmpAForm); }
	}

	// Expose the Doc surface as globals so both `getField(...)` and `this.getField(...)` resolve
	// (in the vm context, a script's `this` is the sandbox global).
	tmpSandbox.getField = tmpDoc.getField.bind(tmpDoc);
	tmpSandbox.getNthFieldName = tmpDoc.getNthFieldName.bind(tmpDoc);
	tmpSandbox.calculateNow = tmpDoc.calculateNow.bind(tmpDoc);
	tmpSandbox.resetForm = tmpDoc.resetForm.bind(tmpDoc);
	tmpSandbox.mailForm = tmpDoc.mailForm.bind(tmpDoc);
	tmpSandbox.print = tmpDoc.print.bind(tmpDoc);
	tmpSandbox.info = tmpDoc.info;
	Object.defineProperty(tmpSandbox, 'numFields', { get() { return tmpState_numFields(pState); } });

	const fSetEvent = (pEvent) => { tmpEventHolder.current = pEvent; tmpSandbox.event = pEvent; };

	return { sandbox: tmpSandbox, setEvent: fSetEvent, warnings: tmpWarnings, doc: tmpDoc };
}

function tmpState_numFields(pState) { return pState.names.length; }

/**
 * Build an Event object for a calculate action on a given field.
 *
 * @param {object} pDoc
 * @param {string} pFieldName
 * @returns {object}
 */
function makeFieldEvent(pDoc, pFieldName, pEventName)
{
	const tmpField = pDoc.getField(pFieldName);
	return {
		type: 'Field',
		name: pEventName || 'Calculate',
		target: tmpField,
		targetName: pFieldName,
		source: tmpField,
		value: tmpField ? tmpField.value : '',
		rc: true,
		willCommit: true,
		change: '',
		changeEx: undefined,
		selStart: 0,
		selEnd: 0
	};
}

function makeCalculateEvent(pDoc, pFieldName) { return makeFieldEvent(pDoc, pFieldName, 'Calculate'); }

module.exports = { buildSandbox, makeCalculateEvent, makeFieldEvent, AForm, Util, Color, DateFormats, TimeFormats };
