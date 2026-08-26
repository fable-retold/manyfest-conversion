const libMappingManyfestBuilder = require('./services/Service-MappingManyfestBuilder.js');
const libPDFFormFiller = require('./services/Service-PDFFormFiller.js');
const libPDFFormCalculator = require('./services/Service-PDFFormCalculator.js');
const libXLSXFormFiller = require('./services/Service-XLSXFormFiller.js');
const libConversionReport = require('./services/Service-ConversionReport.js');

module.exports = (
	{
		MappingManyfestBuilder: libMappingManyfestBuilder,
		PDFFormFiller: libPDFFormFiller,
		PDFFormCalculator: libPDFFormCalculator,
		XLSXFormFiller: libXLSXFormFiller,
		ConversionReport: libConversionReport
	});
