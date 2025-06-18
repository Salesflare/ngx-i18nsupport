/**
 * Created by roobm on 15.03.2017.
 * Interfaces for command line call and config file content.
 */

/**
 * Options that can be passed as program arguments.
 */
export interface ProgramOptions {
    quiet?: boolean;
    verbose?: boolean;
    profilePath?: string;
    languages?: string[];
}

/**
 * Definition of the possible values used in the config file
 */
export interface IConfigFile {
    // content is wrapped in "xliffmergeOptions" to allow to use it embedded in another config file (e.g. tsconfig.json)
    xliffmergeOptions?: IXliffMergeOptions;
}

export interface IXliffMergeOptions {
    quiet?: boolean;   // Flag to only output error messages
    verbose?: boolean;   // Flag to generate debug output messages
    allowIdChange?: boolean; // Try to find translation even when id is missing
    defaultLanguage?: string;    // the default language (the language, which is used in the original templates)
    languages?: string[];   // all languages, if not specified via commandline
    srcDir?: string;    // Directory, where the master file is
    i18nBaseFile?: string; // Basename for i18n input and output, default is 'messages'
    i18nFile?: string;  // master file, if not absolute, it is relative to srcDir
    i18nFormat?: string; // xlf or xmb
    encoding?: string;  // encoding to write xml
    genDir?: string;    // directory, where the files are written to
    angularCompilerOptions?: {
        genDir?: string;    // same as genDir, just to be compatible with ng-xi18n
    };
    removeUnusedIds?: boolean;
    supportNgxTranslate?: boolean;  // Flag, wether output for ngx-translate should be generated
    ngxTranslateExtractionPattern?: string; // Criteria, what messages should be used for ngx-translate output
      // see details on the documentation page https://github.com/martinroob/ngx-i18nsupport/wiki/ngx-translate-usage
    useSourceAsTarget?: boolean; // Flag, whether source must be used as target for new trans-units
    targetPraefix?: string; // Praefix for target copied from sourced
    targetSuffix?: string; // Suffix for target copied from sourced
    beautifyOutput?: boolean; // beautify output
    preserveOrder?: boolean; // preserve order of new trans units
    autotranslate?: boolean|string[]; // enable auto translate via Google Translate or ChatGPT
        // if it is an array, list of languages to autotranslate
        // if it is true, autotranslate all languages (except source language of course)
        // if it is false (default) no autotranslate
    provider?: string;    // Translation provider: "google" (default) or "chatgpt"
    apikey?: string;    // API Key for Google Translate, required if autotranslate is enabled and provider is "google"
    apikeyfile?: string;    // file name where API Key for Google Translate can be read from
    openAiApiKey?: string;    // API Key for OpenAI/ChatGPT, required if autotranslate is enabled and provider is "chatgpt"
    openAiApiKeyFile?: string;    // file name where API Key for OpenAI/ChatGPT can be read from
    openAiModel?: string;    // OpenAI model to use for translation (default "gpt-3.5-turbo")
}

