import {format} from 'util';
import * as request from 'request';
import {Observable} from 'rxjs';
import {of, forkJoin, throwError} from 'rxjs';
import {map} from 'rxjs/operators';

/**
 * Created by roobm on 03.07.2017.
 * Low Level Service to call Google Translate.
 */

/**
 * Types form google translate api.
 */

interface GetSupportedLanguagesRequest {
    target: string; // The language to use to return localized, human readable names of supported\nlanguages.
}

interface LanguagesResource {
    language: string; // code of the language
    name: string; // human readable name (in target language)
}

interface LanguagesListResponse {
    languages: LanguagesResource[];
}

interface TranslateTextRequest {
    q: string[];  // The input texts to translate
    target: string; // The language to use for translation of the input text
    source: string; // The language of the source text
    format?: string; // "html" (default) or "text"
    model?: string; // see public documentation
}

interface TranslationsResource {
    detectedSourceLanguage?: string;
    model?: string;
    translatedText: string;
}

interface TranslationsListResponse {
    translations: TranslationsResource[];
}

interface InternalRequestResponse {
    response: request.RequestResponse;
    body: any;
}

const MAX_SEGMENTS = 128;

/**
 * Interface for translation providers
 */
export interface TranslationProvider {
    /**
     * Translate multiple strings at once
     * @param messages messages to translate
     * @param from source language code
     * @param to target language code
     * @return Observable with translated messages or error
     */
    translateMultipleStrings(messages: string[], from: string, to: string): Observable<string[]>;

    /**
     * Get supported languages
     * @param target language code for localized names
     * @return Observable with supported languages
     */
    getSupportedLanguages(target?: string): Observable<Language[]>;
}

export interface Language {
    language: string; // code of the language
    name: string; // human readable name (in target language)
}

/**
 * Interface for translation directives
 */
export interface TranslationDirective {
    /**
     * The type of directive
     */
    type: 'preserve' | 'replace' | 'format' | 'context';
    
    /**
     * The pattern to match (regex or exact string)
     */
    pattern: string;
    
    /**
     * The replacement or instruction
     */
    instruction: string;
    
    /**
     * Whether the pattern is a regex
     */
    isRegex?: boolean;
}

/**
 * Google Translate implementation
 */
export class GoogleTranslateProvider implements TranslationProvider {
    private _request: request.RequestAPI<request.Request, request.CoreOptions, request.RequiredUriUrl>;
    private _rootUrl: string;
    private _apiKey: string;

    constructor(apiKey: string) {
        this._request = request;
        this._apiKey = apiKey;
        this._rootUrl = 'https://translation.googleapis.com/';
    }

    /**
     * Change API key (just for tests).
     * @param apikey apikey
     */
    public setApiKey(apiKey: string) {
        this._apiKey = apiKey;
    }

    /**
     * Translate an array of messages at once.
     * @param messages the messages to be translated
     * @param from source language code
     * @param to target language code
     * @return Observable with translated messages or error
     */
    public translateMultipleStrings(messages: string[], from: string, to: string): Observable<string[]> {
        // empty array needs no translation and always works ... (#78)
        if (messages.length === 0) {
            return of([]);
        }
        if (!this._apiKey) {
            return throwError('cannot autotranslate: no api key');
        }
        if (!from || !to) {
            return throwError('cannot autotranslate: source and target language must be set');
        }
        from = AutoTranslateService.stripRegioncode(from);
        to = AutoTranslateService.stripRegioncode(to);
        const allRequests: Observable<string[]>[] = this.splitMessagesToGoogleLimit(messages).map((partialMessages: string[]) => {
            return this.limitedTranslateMultipleStrings(partialMessages, from, to);
        });
        return forkJoin(allRequests).pipe(
            map((allTranslations: string[][]) => {
                let all = [];
                for (let i = 0; i < allTranslations.length; i++) {
                    all = all.concat(allTranslations[i]);
                }
                return all;
        }));
    }

    public getSupportedLanguages(target?: string): Observable<Language[]> {
        const realUrl = this._rootUrl + 'language/translate/v2/languages' + '?key=' + this._apiKey;
        const request: GetSupportedLanguagesRequest = {
            target: target || 'en'
        };
        const options = {
            url: realUrl,
            qs: request,
            json: true
        };
        return this.get(realUrl, options).pipe(
            map((data) => {
                const body: any = data.body;
                if (!body) {
                    throw new Error('no result received');
                }
                if (body.error) {
                    throw new Error(format('Error %s: %s', body.error.code, body.error.message));
                }
                return body.data.languages;
            })
        );
    }

    private stripRegioncode(lang: string): string {
        const langLower = lang.toLowerCase();
        for (let i = 0; i < langLower.length; i++) {
            const c = langLower.charAt(i);
            if (c < 'a' || c > 'z') {
                return langLower.substring(0, i);
            }
        }
        return langLower;
    }

    private splitMessagesToGoogleLimit(messages: string[]): string[][] {
        if (messages.length <= MAX_SEGMENTS) {
            return [messages];
        }
        const result = [];
        let currentPackage = [];
        let packageSize = 0;
        for (let i = 0; i < messages.length; i++) {
            currentPackage.push(messages[i]);
            packageSize++;
            if (packageSize >= MAX_SEGMENTS) {
                result.push(currentPackage);
                currentPackage = [];
                packageSize = 0;
            }
        }
        if (currentPackage.length > 0) {
            result.push(currentPackage);
        }
        return result;
    }

    private limitedTranslateMultipleStrings(messages: string[], from: string, to: string): Observable<string[]> {
        const realUrl = this._rootUrl + 'language/translate/v2' + '?key=' + this._apiKey;
        const translateRequest: TranslateTextRequest = {
            q: messages,
            target: to,
            source: from,
        };
        const options = {
            url: realUrl,
            body: translateRequest,
            json: true,
        };
        return this.post(realUrl, options).pipe(
            map((data) => {
                const body: any = data.body;
                if (!body) {
                    throw new Error('no result received');
                }
                if (body.error) {
                    if (body.error.code === 400) {
                        if (body.error.message === 'Invalid Value') {
                            throw new Error(format('Translation from "%s" to "%s" not supported', from, to));
                        }
                        throw new Error(format('Invalid request: %s', body.error.message));
                    } else {
                        throw new Error(format('Error %s: %s', body.error.code, body.error.message));
                    }
                }
                const result = body.data;
                return result.translations.map((translation: TranslationsResource) => {
                    return translation.translatedText;
                });
            })
        );
    }

    private post(uri: string, options?: request.CoreOptions): Observable<InternalRequestResponse> {
        return <Observable<InternalRequestResponse>> this._call.apply(this, [].concat('post', <string> uri,
            <request.CoreOptions> Object.assign({}, options || {})));
    }

    private get(uri: string, options?: request.CoreOptions): Observable<InternalRequestResponse> {
        return <Observable<InternalRequestResponse>> this._call.apply(this, [].concat('get', <string> uri,
            <request.CoreOptions> Object.assign({}, options || {})));
    }

    private _call(method: string, uri: string, options?: request.CoreOptions): Observable<InternalRequestResponse> {
        return <Observable<InternalRequestResponse>> Observable.create((observer) => {
            const params = [].concat(<string> uri, <request.CoreOptions> Object.assign({}, options || {}),
                <RequestCallback>(error: any, response: request.RequestResponse, body: any) => {
                    if (error) {
                        return observer.error(error);
                    }
                    observer.next(<InternalRequestResponse> Object.assign({}, {
                        response: <request.RequestResponse> response,
                        body: <any> body
                    }));
                    observer.complete();
                });
            try {
                this._request[<string> method].apply(
                    <request.RequestAPI<request.Request,
                    request.CoreOptions,
                    request.RequiredUriUrl>> this._request,
                    params);
            } catch (error) {
                observer.error(error);
            }
        });
    }
}

/**
 * ChatGPT implementation
 */
export class ChatGPTProvider implements TranslationProvider {
    private _apiKey: string;
    private _model: string;
    private _directives: TranslationDirective[] = [];
    private _context: string = '';

    constructor(apiKey: string, model: string = 'gpt-4o-mini') {
        this._apiKey = apiKey;
        this._model = model;
    }

    public setApiKey(apiKey: string) {
        this._apiKey = apiKey;
    }

    /**
     * Add translation directives
     * @param directives array of translation directives
     */
    public setDirectives(directives: TranslationDirective[]) {
        this._directives = directives;
    }

    /**
     * Set context for translations
     * @param context additional context to help with translation
     */
    public setContext(context: string) {
        this._context = context;
    }

    public translateMultipleStrings(messages: string[], from: string, to: string): Observable<string[]> {
        if (messages.length === 0) {
            return of([]);
        }
        if (!this._apiKey) {
            return throwError('cannot autotranslate: no api key');
        }
        if (!from || !to) {
            return throwError('cannot autotranslate: source and target language must be set');
        }

        // Process messages in batches to avoid token limits
        const batchSize = 10;
        const batches = [];
        for (let i = 0; i < messages.length; i += batchSize) {
            batches.push(messages.slice(i, i + batchSize));
        }

        const batchRequests = batches.map(batch => this.translateBatch(batch, from, to));
        return forkJoin(batchRequests).pipe(
            map(results => results.reduce((acc, curr) => acc.concat(curr), []))
        );
    }

    private translateBatch(messages: string[], from: string, to: string): Observable<string[]> {
        // Build the prompt with directives and context
        let prompt = `Translate the following ${messages.length} texts from ${from} to ${to}. `;
        
        if (this._context) {
            prompt += `\nContext: ${this._context}\n`;
        }

        if (this._directives.length > 0) {
            prompt += '\nTranslation rules:\n';
            this._directives.forEach(directive => {
                switch (directive.type) {
                    case 'preserve':
                        prompt += `- Preserve any text matching "${directive.pattern}" exactly as is\n`;
                        break;
                    case 'replace':
                        prompt += `- Replace any text matching "${directive.pattern}" with "${directive.instruction}"\n`;
                        break;
                    case 'format':
                        prompt += `- Maintain the format of any text matching "${directive.pattern}"\n`;
                        break;
                    case 'context':
                        prompt += `- When translating text matching "${directive.pattern}", consider: ${directive.instruction}\n`;
                        break;
                }
            });
        }

        prompt += `\nReturn only the translations in a JSON array format, maintaining the same order.
        Texts to translate: ${JSON.stringify(messages)}`;

        const options = {
            url: 'https://api.openai.com/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this._apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: this._model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3
            })
        };

        return new Observable<string[]>(observer => {
            request(options, (error, response, body) => {
                if (error) {
                    observer.error(error);
                    return;
                }
                try {
                    const result = JSON.parse(body);
                    const translations = JSON.parse(result.choices[0].message.content);
                    
                    // Apply any post-translation directives
                    const processedTranslations = translations.map((translation: string) => {
                        return this.applyPostTranslationDirectives(translation);
                    });
                    
                    observer.next(processedTranslations);
                    observer.complete();
                } catch (e) {
                    observer.error(e);
                }
            });
        });
    }

    private applyPostTranslationDirectives(text: string): string {
        let result = text;
        this._directives.forEach(directive => {
            if (directive.type === 'preserve' || directive.type === 'replace') {
                const pattern = directive.isRegex ? new RegExp(directive.pattern, 'g') : directive.pattern;
                if (directive.type === 'preserve') {
                    // Find all matches in the original text and restore them
                    const matches = text.match(pattern);
                    if (matches) {
                        matches.forEach(match => {
                            result = result.replace(match, match);
                        });
                    }
                } else {
                    // Replace matches with the instruction
                    result = result.replace(pattern, directive.instruction);
                }
            }
        });
        return result;
    }

    public getSupportedLanguages(target?: string): Observable<Language[]> {
        // ChatGPT supports all languages, so we return a comprehensive list
        return of([
            { language: 'en', name: 'English' },
            { language: 'es', name: 'Spanish' },
            { language: 'fr', name: 'French' },
            { language: 'de', name: 'German' },
            { language: 'it', name: 'Italian' },
            { language: 'pt', name: 'Portuguese' },
            { language: 'ru', name: 'Russian' },
            { language: 'zh', name: 'Chinese' },
            { language: 'ja', name: 'Japanese' },
            { language: 'ko', name: 'Korean' },
            // Add more languages as needed
        ]);
    }
}

/**
 * Main auto-translate service that can use different providers
 */
export class AutoTranslateService {
    private provider: TranslationProvider;

    constructor(provider: TranslationProvider) {
        this.provider = provider;
    }

    public translateMultipleStrings(messages: string[], from: string, to: string): Observable<string[]> {
        return this.provider.translateMultipleStrings(messages, from, to);
    }

    public getSupportedLanguages(target?: string): Observable<Language[]> {
        return this.provider.getSupportedLanguages(target);
    }
}
