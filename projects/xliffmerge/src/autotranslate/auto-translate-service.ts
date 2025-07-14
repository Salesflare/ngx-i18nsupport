import {format} from 'util';
import * as request from 'request';
import {Observable} from 'rxjs';
import {of, forkJoin, throwError} from 'rxjs';
import {map, catchError} from 'rxjs/operators';

/**
 * Created by roobm on 03.07.2017.
 * Low Level Service to call Google Translate or OpenAI/ChatGPT for translation.
 */

/**
 * Types for Google Translate API.
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

/**
 * Types for OpenAI API.
 */

interface OpenAIChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface OpenAIChatRequest {
    model: string;
    messages: OpenAIChatMessage[];
    temperature?: number;
    max_tokens?: number;
}

interface OpenAIChatChoice {
    message: {
        content: string;
    };
    finish_reason: string;
}

interface OpenAIChatResponse {
    choices: OpenAIChatChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

interface OpenAIError {
    error: {
        message: string;
        type: string;
        code?: string;
    };
}

interface InternalRequestResponse {
    response: request.RequestResponse;
    body: any;
}

const MAX_SEGMENTS_GOOGLE = 128;
const MAX_SEGMENTS_OPENAI = 50; // OpenAI has different limits than Google, using a conservative number

export type TranslationProvider = 'google' | 'chatgpt';

export class AutoTranslateService {

    private _request: request.RequestAPI<request.Request, request.CoreOptions, request.RequiredUriUrl>;
    private _rootUrl: string;
    private _apiKey: string;
    private _provider: TranslationProvider;
    private _openAiModel: string;

    /**
     * Strip region code and convert to lower
     * @param lang lang
     * @return lang without region code and in lower case.
     */
    public static stripRegioncode(lang: string): string {
        const langLower = lang.toLowerCase();
        for (let i = 0; i < langLower.length; i++) {
            const c = langLower.charAt(i);
            if (c < 'a' || c > 'z') {
                return langLower.substring(0, i);
            }
        }
        return langLower;
    }

    constructor(apiKey: string, provider: TranslationProvider = 'google', openAiModel: string = 'gpt-3.5-turbo') {
        this._request = request;
        this._apiKey = apiKey;
        this._provider = provider;
        this._openAiModel = openAiModel;
        
        if (provider === 'chatgpt') {
            this._rootUrl = 'https://api.openai.com/v1/';
        } else {
            this._rootUrl = 'https://translation.googleapis.com/';
        }
    }

    /**
     * Change API key (just for tests).
     * @param apikey apikey
     */
    public setApiKey(apikey: string) {
        this._apiKey = apikey;
    }

    /**
     * Change model (for OpenAI provider).
     * @param model model name
     */
    public setModel(model: string) {
        this._openAiModel = model;
    }

    /**
     * Get the current provider.
     * @return current provider
     */
    public getProvider(): TranslationProvider {
        return this._provider;
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
            const errorMsg = this._provider === 'chatgpt' 
                ? 'cannot autotranslate: no OpenAI API key'
                : 'cannot autotranslate: no api key';
            return throwError(errorMsg);
        }
        if (!from || !to) {
            return throwError('cannot autotranslate: source and target language must be set');
        }
        from = AutoTranslateService.stripRegioncode(from);
        to = AutoTranslateService.stripRegioncode(to);
        
        if (this._provider === 'chatgpt') {
            return this.translateWithOpenAI(messages, from, to);
        } else {
            return this.translateWithGoogle(messages, from, to);
        }
    }

    /**
     * Translate using Google Translate API
     */
    private translateWithGoogle(messages: string[], from: string, to: string): Observable<string[]> {
        const allRequests: Observable<string[]>[] = this.splitMessagesToGoogleLimit(messages).map((partialMessages: string[]) => {
            return this.limitedTranslateMultipleStringsGoogle(partialMessages, from, to);
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

    /**
     * Translate using OpenAI/ChatGPT API
     */
    private translateWithOpenAI(messages: string[], from: string, to: string): Observable<string[]> {
        const allRequests: Observable<string[]>[] = this.splitMessagesToOpenAILimit(messages).map((partialMessages: string[]) => {
            return this.limitedTranslateMultipleStringsOpenAI(partialMessages, from, to);
        });
        
        return forkJoin(allRequests).pipe(
            map((allTranslations: string[][]) => {
                let all = [];
                for (let i = 0; i < allTranslations.length; i++) {
                    all = all.concat(allTranslations[i]);
                }
                return all;
            }),
            catchError((error) => {
                return throwError(`OpenAI translation error: ${error.message}`);
            })
        );
    }

    private splitMessagesToGoogleLimit(messages: string[]): string[][] {
        if (messages.length <= MAX_SEGMENTS_GOOGLE) {
            return [messages];
        }
        const result = [];
        let currentPackage = [];
        let packageSize = 0;
        for (let i = 0; i < messages.length; i++) {
            currentPackage.push(messages[i]);
            packageSize++;
            if (packageSize >= MAX_SEGMENTS_GOOGLE) {
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

    private splitMessagesToOpenAILimit(messages: string[]): string[][] {
        if (messages.length <= MAX_SEGMENTS_OPENAI) {
            return [messages];
        }
        const result = [];
        let currentPackage = [];
        let packageSize = 0;
        for (let i = 0; i < messages.length; i++) {
            currentPackage.push(messages[i]);
            packageSize++;
            if (packageSize >= MAX_SEGMENTS_OPENAI) {
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

    /**
     * Return translation request, but messages must be limited to google limits.
     * Not more that 128 single messages.
     * @param messages messages
     * @param from from
     * @param to to
     * @return the translated strings
     */
    private limitedTranslateMultipleStringsGoogle(messages: string[], from: string, to: string): Observable<string[]> {
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
//            proxy: 'http://127.0.0.1:8888' To set a proxy use env var HTTPS_PROXY
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
        }));
    }

    /**
     * Return translation request, but messages must be limited to OpenAI limits.
     * @param messages messages
     * @param from from
     * @param to to
     * @return the translated strings
     */
    private limitedTranslateMultipleStringsOpenAI(messages: string[], from: string, to: string): Observable<string[]> {
        // For OpenAI, we'll process each message individually to ensure proper handling
        const individualRequests: Observable<string>[] = messages.map((message: string) => {
            return this.translateSingleMessageOpenAI(message, from, to);
        });
        
        return forkJoin(individualRequests);
    }

    /**
     * Translate a single message using OpenAI API
     * @param message the message to translate
     * @param from source language code
     * @param to target language code
     * @return Observable with translated message
     */
    private translateSingleMessageOpenAI(message: string, from: string, to: string): Observable<string> {
        const realUrl = this._rootUrl + 'chat/completions';

        // Trim the API key to remove accidental whitespace
        const apiKey = (this._apiKey || '').trim();

        // Debug logging
        // eslint-disable-next-line no-console
        console.debug('[OpenAI] Endpoint:', realUrl);
        // eslint-disable-next-line no-console
        console.debug('[OpenAI] API Key (first 4, last 4):', apiKey.slice(0, 4) + '...' + apiKey.slice(-4));

        // Create the prompt for translation
        const systemPrompt = `You are a professional translator. Translate the given text from ${from} to ${to}. 
        Provide only the translation without any explanations, comments, or additional text. 
        Preserve any formatting, placeholders, or special characters in the original text.`;
        
        const userPrompt = `Translate this text from ${from} to ${to}: ${message}`;
        
        const chatRequest: OpenAIChatRequest = {
            model: this._openAiModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.3, // Lower temperature for more consistent translations
            max_tokens: 1000 // Reasonable limit for translations
        };

        const options = {
            url: realUrl,
            body: chatRequest,
            json: true,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        };

        return this.post(realUrl, options).pipe(
            map((data) => {
                const body: any = data.body;
                if (!body) {
                    throw new Error('no result received from OpenAI');
                }
                // Log the full error response for debugging
                if (body.error) {
                    // eslint-disable-next-line no-console
                    console.error('[OpenAI] Error response:', JSON.stringify(body, null, 2));
                    const error: OpenAIError = body;
                    if (error.error.code === 'invalid_api_key') {
                        throw new Error('OpenAI API key is invalid');
                    } else if (error.error.code === 'rate_limit_exceeded') {
                        throw new Error('OpenAI rate limit exceeded');
                    } else if (error.error.code === 'insufficient_quota') {
                        throw new Error('OpenAI quota exceeded');
                    } else {
                        throw new Error(format('OpenAI API error: %s', error.error.message));
                    }
                }
                const response: OpenAIChatResponse = body;
                if (!response.choices || response.choices.length === 0) {
                    throw new Error('no translation choices received from OpenAI');
                }
                const translatedText = response.choices[0].message.content.trim();
                if (!translatedText) {
                    throw new Error('empty translation received from OpenAI');
                }
                return translatedText;
            }),
            catchError((error) => {
                if (error.message.includes('OpenAI')) {
                    return throwError(error);
                } else {
                    return throwError(format('OpenAI translation failed: %s', error.message));
                }
            })
        );
    }

    /**
     * Function to do a POST HTTP request
     *
     * @param uri uri
     * @param options options
     *
     * @return response
     */
    post(uri: string, options?: request.CoreOptions): Observable<InternalRequestResponse> {
        return <Observable<InternalRequestResponse>> this._call.apply(this, [].concat('post', <string> uri,
            <request.CoreOptions> Object.assign({}, options || {})));
    }

    /**
     * Function to do a HTTP request for given method
     *
     * @param method method
     * @param uri uri
     * @param options options
     *
     * @return response
     *
     */
    private _call(method: string, uri: string, options?: request.CoreOptions): Observable<InternalRequestResponse> {
        return <Observable<InternalRequestResponse>> Observable.create((observer) => {
            // build params array
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

            // _call request method
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
