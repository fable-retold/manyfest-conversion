const libCommandLineCommand = require('pict-service-commandlineutility').ServiceCommandLineCommand;

class ManyfestConversionCommandFillPDF extends libCommandLineCommand
{
	constructor(pFable, pManifest, pServiceHash)
	{
		super(pFable, pManifest, pServiceHash);

		this.options.CommandKeyword = 'fill-pdf';
		this.options.Description = 'Fill a PDF form from a source JSON payload using a mapping manyfest.';
		this.options.Aliases.push('fp');
		this.options.Aliases.push('fill_pdf');

		this.options.CommandOptions.push({ Name: '-m, --mapping [filepath]', Description: 'The mapping manyfest JSON file.' });
		this.options.CommandOptions.push({ Name: '-s, --source [filepath]', Description: 'The source JSON payload to read data from.' });
		this.options.CommandOptions.push({ Name: '-t, --template [filepath]', Description: 'The template PDF file to fill.' });
		this.options.CommandOptions.push({ Name: '-o, --output [filepath]', Description: 'The filled PDF output path.' });
		this.options.CommandOptions.push({ Name: '-r, --source-root [address]', Description: 'Override the mapping manyfest SourceRootAddress.' });
		this.options.CommandOptions.push({ Name: '--sidecar [filepath]', Description: 'Sidecar report path.  Defaults to <output>.report.json.' });
		this.options.CommandOptions.push({ Name: '--no-calculate', Description: 'Do not run the form\'s embedded calculation scripts (leave derived cells uncomputed).' });

		this.addCommand();
	}

	async onRunAsync(fCallback)
	{
		const tmpOperationState = (
			{
				RawMappingFile: this.CommandOptions.mapping,
				RawSourceFile: this.CommandOptions.source,
				RawTemplateFile: this.CommandOptions.template,
				RawOutputFile: this.CommandOptions.output,
				RawSidecarFile: this.CommandOptions.sidecar,
				SourceRootOverride: this.CommandOptions.sourceRoot
			});

		const tmpRequiredKeys = ['RawMappingFile', 'RawSourceFile', 'RawTemplateFile', 'RawOutputFile'];
		for (let i = 0; i < tmpRequiredKeys.length; i++)
		{
			const tmpKey = tmpRequiredKeys[i];
			if (!tmpOperationState[tmpKey] || typeof(tmpOperationState[tmpKey]) !== 'string')
			{
				this.fable.log.error(`Missing required option for fill-pdf: ${tmpKey}`);
				return fCallback();
			}
		}

		this.fable.instantiateServiceProvider('FilePersistence');
		this.fable.addAndInstantiateServiceTypeIfNotExists('MappingManyfestBuilder', require('../../services/Service-MappingManyfestBuilder.js'));
		this.fable.addAndInstantiateServiceTypeIfNotExists('PDFFormFiller', require('../../services/Service-PDFFormFiller.js'));
		this.fable.addAndInstantiateServiceTypeIfNotExists('PDFFormCalculator', require('../../services/Service-PDFFormCalculator.js'));
		this.fable.addAndInstantiateServiceTypeIfNotExists('ConversionReport', require('../../services/Service-ConversionReport.js'));

		tmpOperationState.MappingFilePath = this.fable.FilePersistence.resolvePath(tmpOperationState.RawMappingFile);
		tmpOperationState.SourceFilePath = this.fable.FilePersistence.resolvePath(tmpOperationState.RawSourceFile);
		tmpOperationState.TemplateFilePath = this.fable.FilePersistence.resolvePath(tmpOperationState.RawTemplateFile);
		tmpOperationState.OutputFilePath = this.fable.FilePersistence.resolvePath(tmpOperationState.RawOutputFile);
		tmpOperationState.SidecarFilePath = tmpOperationState.RawSidecarFile
			? this.fable.FilePersistence.resolvePath(tmpOperationState.RawSidecarFile)
			: `${tmpOperationState.OutputFilePath}.report.json`;

		if (!this.fable.FilePersistence.existsSync(tmpOperationState.MappingFilePath))
		{
			this.fable.log.error(`Mapping manyfest file does not exist: ${tmpOperationState.MappingFilePath}`);
			return fCallback();
		}
		if (!this.fable.FilePersistence.existsSync(tmpOperationState.SourceFilePath))
		{
			this.fable.log.error(`Source JSON file does not exist: ${tmpOperationState.SourceFilePath}`);
			return fCallback();
		}
		if (!this.fable.FilePersistence.existsSync(tmpOperationState.TemplateFilePath))
		{
			this.fable.log.error(`Template PDF file does not exist: ${tmpOperationState.TemplateFilePath}`);
			return fCallback();
		}

		let tmpMappingManyfest;
		try
		{
			tmpMappingManyfest = this.fable.MappingManyfestBuilder.loadMappingManyfestFromFile(tmpOperationState.MappingFilePath);
		}
		catch (pError)
		{
			this.fable.log.error(`Failed to load mapping manyfest: ${pError.message}`);
			return fCallback();
		}

		if (tmpOperationState.SourceRootOverride)
		{
			tmpMappingManyfest.manifest.SourceRootAddress = tmpOperationState.SourceRootOverride;
		}

		let tmpSourceData;
		try
		{
			const tmpSourceRaw = this.fable.FilePersistence.readFileSync(tmpOperationState.SourceFilePath);
			tmpSourceData = JSON.parse(tmpSourceRaw);
		}
		catch (pError)
		{
			this.fable.log.error(`Failed to parse source JSON: ${pError.message}`);
			return fCallback();
		}

		const tmpReport = this.fable.ConversionReport.newReport(
			tmpOperationState.SourceFilePath,
			tmpMappingManyfest.manifest ? tmpMappingManyfest.manifest.TargetFile : tmpOperationState.TemplateFilePath,
			tmpMappingManyfest);

		const tmpCalculate = (this.CommandOptions.calculate !== false);
		try
		{
			await this.fable.PDFFormFiller.fillPDFWithCalculations(
				tmpMappingManyfest,
				tmpSourceData,
				tmpOperationState.TemplateFilePath,
				tmpOperationState.OutputFilePath,
				tmpReport,
				this.fable.ConversionReport,
				this.fable.PDFFormCalculator,
				{ Calculate: tmpCalculate });
		}
		catch (pError)
		{
			this.fable.log.error(`PDF fill failed: ${pError.message}`);
			this.fable.ConversionReport.writeSidecar(tmpReport, tmpOperationState.SidecarFilePath);
			return fCallback();
		}

		this.fable.ConversionReport.writeSidecar(tmpReport, tmpOperationState.SidecarFilePath);

		this.fable.log.info(`Filled PDF written to ${tmpOperationState.OutputFilePath}`);
		this.fable.log.info(`Sidecar report written to ${tmpOperationState.SidecarFilePath}`);
		this.fable.log.info(`Stats: ${tmpReport.Stats.SuccessCount} success, ${tmpReport.Stats.WarningCount} warning, ${tmpReport.Stats.ErrorCount} error (${tmpReport.Stats.TotalFields} total)`);

		if (tmpReport.Stats.ErrorCount > 0)
		{
			process.exitCode = 2;
		}

		return fCallback();
	}
}

module.exports = ManyfestConversionCommandFillPDF;
