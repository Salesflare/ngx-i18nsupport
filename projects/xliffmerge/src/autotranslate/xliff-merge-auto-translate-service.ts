import {isNullOrUndefined} from '../common/util';
import {Observable, forkJoin, of} from 'rxjs';
import {map, catchError} from 'rxjs/operators';
import * as entityDecoderLib from 'he';
import {
    IICUMessage, IICUMessageTranslation, INormalizedMessage, ITranslationMessagesFile, ITransUnit,
    STATE_NEW
} from '@ngx-i18nsupport/ngx-i18nsupport-lib';
import {AutoTranslateService, GoogleTranslateProvider, ChatGPTProvider, TranslationDirective} from './auto-translate-service';
import {AutoTranslateResult} from './auto-translate-result';
import {AutoTranslateSummaryReport} from './auto-translate-summary-report';
import { CommandOutput } from '../public_api';
/**
 * Created by martin on 07.07.2017.
 * Service to autotranslate Transunits via different translation providers.
 */

export class XliffMergeAutoTranslateService {

    private commandOutput: CommandOutput;
    private autoTranslateService: AutoTranslateService;
    private _provider: 'google' | 'chatgpt';
    private _model?: string;
    private _directives: TranslationDirective[] = [];
    private _context: string = '';

    constructor(commandOutput: CommandOutput, apikey: string, provider: 'google' | 'chatgpt' = 'google', model?: string) {
        this._provider = provider;
        this._model = model;
        this.commandOutput = commandOutput;

        // Validate API key format based on provider
        if (provider === 'chatgpt') {
            if (!apikey.startsWith('sk-')) {
                throw new Error('Invalid OpenAI API key format. OpenAI API keys should start with "sk-". Please provide a valid OpenAI API key or switch to Google Translate provider.');
            }
        } else if (provider === 'google') {
            if (!apikey.startsWith('AIza')) {
                throw new Error('Invalid Google Translate API key format. Google API keys should start with "AIza". Please provide a valid Google Translate API key or switch to ChatGPT provider.');
            }
        }
        
        this.initializeService(apikey);
    }

    private initializeService(apikey: string) {
        this.commandOutput.info('Initializing auto-translate service with API key: ' + apikey);
        this.commandOutput.info('Provider: ' + this._provider);
        const translationProvider = this._provider === 'google' 
            ? new GoogleTranslateProvider(apikey)
            : new ChatGPTProvider(apikey, this._model);
        
        if (this._provider === 'chatgpt') {
            const chatGPTProvider = translationProvider as ChatGPTProvider;
            if (this._directives.length > 0) {
                chatGPTProvider.setDirectives(this._directives);
            }
            if (this._context) {
                chatGPTProvider.setContext(this._context);
            }
        }
        
        this.commandOutput.info(`Using instance ${translationProvider instanceof ChatGPTProvider ? 'ChatGPT' : 'Google Translate'}`);
        this.autoTranslateService = new AutoTranslateService(translationProvider);
    }

    /**
     * Set translation directives for ChatGPT provider
     * @param directives array of translation directives
     */
    public setDirectives(directives: TranslationDirective[]) {
        this._directives = directives;
        if (this._provider === 'chatgpt') {
            const chatGPTProvider = (this.autoTranslateService as any).provider as ChatGPTProvider;
            chatGPTProvider.setDirectives(directives);
        }
    }

    /**
     * Set context for translations (ChatGPT provider only)
     * @param context additional context to help with translation
     */
    public setContext(context: string) {
        this._context = context;
        if (this._provider === 'chatgpt') {
            const chatGPTProvider = (this.autoTranslateService as any).provider as ChatGPTProvider;
            chatGPTProvider.setContext(context);
        }
    }

    /**
     * Change the API key
     * @param apikey new API key
     */
    public setApiKey(apikey: string) {
        this.initializeService(apikey);
    }

    /**
     * Auto translate file via Google Translate.
     * Will translate all new units in file.
     * @param from from
     * @param to to
     * @param languageSpecificMessagesFile languageSpecificMessagesFile
     * @return a promise with the execution result as a summary report.
     */
    public autoTranslate(from: string, to: string, languageSpecificMessagesFile: ITranslationMessagesFile)
        : Observable<AutoTranslateSummaryReport> {
        return forkJoin([
            this.doAutoTranslateNonICUMessages(from, to, languageSpecificMessagesFile),
            ...this.doAutoTranslateICUMessages(from, to, languageSpecificMessagesFile)])
            .pipe(
                map((summaries: AutoTranslateSummaryReport[]) => {
                    const summary = summaries[0];
                    for (let i = 1; i < summaries.length; i++) {
                        summary.merge(summaries[i]);
                    }
                    return summary;
        }));
    }

    /**
     * Collect all units that are untranslated.
     * @param languageSpecificMessagesFile languageSpecificMessagesFile
     * @return all untranslated units
     */
    private allUntranslatedTUs(languageSpecificMessagesFile: ITranslationMessagesFile): ITransUnit[] {
        // collect all units, that should be auto translated
        const allUntranslated: ITransUnit[] = [];
        languageSpecificMessagesFile.forEachTransUnit((tu) => {
            if (tu.targetState() === STATE_NEW) {
                allUntranslated.push(tu);
            }
        });
        return allUntranslated;
    }

    private doAutoTranslateNonICUMessages(from: string, to: string, languageSpecificMessagesFile: ITranslationMessagesFile)
        : Observable<AutoTranslateSummaryReport> {
        const allUntranslated: ITransUnit[] = this.allUntranslatedTUs(languageSpecificMessagesFile);
        const allTranslatable = allUntranslated.filter((tu) => isNullOrUndefined(tu.sourceContentNormalized().getICUMessage()));
        const allMessages: string[] = allTranslatable.map((tu) => {
            return tu.sourceContentNormalized().asDisplayString();
        });
        return this.autoTranslateService.translateMultipleStrings(allMessages, from, to)
            .pipe(
                // #94 google translate might return &#.. entity refs, that must be decoded
                map((translations: string[]) => translations.map(encodedTranslation => entityDecoderLib.decode(encodedTranslation))),
                map((translations: string[]) => {
                const summary = new AutoTranslateSummaryReport(from, to);
                summary.setIgnored(allUntranslated.length - allTranslatable.length);
                for (let i = 0; i < translations.length; i++) {
                    const tu = allTranslatable[i];
                    const translationText = translations[i];
                    const result = this.autoTranslateNonICUUnit(tu, translationText);
                    summary.addSingleResult(tu, result);
                }
                return summary;
                }),
                catchError((err) => {
                    const failSummary = new AutoTranslateSummaryReport(from, to);
                    failSummary.setError(err.message, allMessages.length);
                    return of(failSummary);
            }));
    }

    private doAutoTranslateICUMessages(from: string, to: string, languageSpecificMessagesFile: ITranslationMessagesFile)
        : Observable<AutoTranslateSummaryReport>[] {
        const allUntranslated: ITransUnit[] = this.allUntranslatedTUs(languageSpecificMessagesFile);
        const allTranslatableICU = allUntranslated.filter((tu) => !isNullOrUndefined(tu.sourceContentNormalized().getICUMessage()));
        return allTranslatableICU.map((tu) => {
            return this.doAutoTranslateICUMessage(from, to, tu);
        });
    }

    /**
     * Translate single ICU Messages.
     * @param from from
     * @param to to
     * @param tu transunit to translate (must contain ICU Message)
     * @return summary report
     */
    private doAutoTranslateICUMessage(from: string, to: string, tu: ITransUnit): Observable<AutoTranslateSummaryReport> {
        const icuMessage: IICUMessage = tu.sourceContentNormalized().getICUMessage();
        const categories = icuMessage.getCategories();
        // check for nested ICUs, we do not support that
        if (categories.find((category) => !isNullOrUndefined(category.getMessageNormalized().getICUMessage()))) {
            const summary = new AutoTranslateSummaryReport(from, to);
            summary.setIgnored(1);
            return of(summary);
        }
        const allMessages: string[] = categories.map((category) => category.getMessageNormalized().asDisplayString());
        return this.autoTranslateService.translateMultipleStrings(allMessages, from, to)
            .pipe(
                // #94 google translate might return &#.. entity refs, that must be decoded
                map((translations: string[]) => translations.map(encodedTranslation => entityDecoderLib.decode(encodedTranslation))),
                map((translations: string[]) => {
                    const summary = new AutoTranslateSummaryReport(from, to);
                    const icuTranslation: IICUMessageTranslation = {};
                    for (let i = 0; i < translations.length; i++) {
                        icuTranslation[categories[i].getCategory()] = translations[i];
                    }
                    const result = this.autoTranslateICUUnit(tu, icuTranslation);
                    summary.addSingleResult(tu, result);
                    return summary;
                }), catchError((err) => {
                    const failSummary = new AutoTranslateSummaryReport(from, to);
                    failSummary.setError(err.message, allMessages.length);
                    return of(failSummary);
            }));
    }

    private autoTranslateNonICUUnit(tu: ITransUnit, translatedMessage: string): AutoTranslateResult {
        return this.autoTranslateUnit(tu, tu.sourceContentNormalized().translate(translatedMessage));
    }

    private autoTranslateICUUnit(tu: ITransUnit, translation: IICUMessageTranslation): AutoTranslateResult {
        return this.autoTranslateUnit(tu, tu.sourceContentNormalized().translateICUMessage(translation));
    }

    private autoTranslateUnit(tu: ITransUnit, translatedMessage: INormalizedMessage): AutoTranslateResult {
        const errors = translatedMessage.validate();
        const warnings = translatedMessage.validateWarnings();
        if (!isNullOrUndefined(errors)) {
            return new AutoTranslateResult(false, 'errors detected, not translated');
        } else if (!isNullOrUndefined(warnings)) {
            return new AutoTranslateResult(false, 'warnings detected, not translated');
        } else {
            tu.translate(translatedMessage);
            return new AutoTranslateResult(true, null); // success
        }
    }
}
