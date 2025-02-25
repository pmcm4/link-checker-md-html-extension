const vscode = require('vscode');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const cheerio = require('cheerio')
const productFolderDictionary = require('./projectDict');

const CONCURRENCY_LIMIT = 50; // Increased concurrency limit for better performance

let diagnosticCollection;

function activate(context) {
    console.log('URL Checker extension is now active!');

    // Create a diagnostic collection for reporting problems
    diagnosticCollection = vscode.languages.createDiagnosticCollection('link-checker-md-html-linter');

    let disposable = vscode.commands.registerCommand('link-checker-md-html-linter.checkUrls', async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showErrorMessage('No active editor found.');
            return;
        }

        const document = editor.document;

        // Check if the file is HTML or Markdown
        if (document.languageId !== 'html' && document.languageId !== 'markdown') {
            vscode.window.showErrorMessage('This extension only works with HTML and Markdown files.');
            return;
        }

        const text = document.getText();

        console.time('URL Extraction');
        // Regex to capture HTML and Markdown links
        const urlRegex = /(?:href|src|action|data|poster|cite|profile|background|ping|formaction)\s*=\s*["']([^"']+)["']/g; // HTML
        const markdownRegex = /\[([^\]]+)\]\(([^)]+)\)/g; // Markdown

        const htmlUrls = Array.from(text.matchAll(urlRegex), match => match[1]);
        const markdownUrls = Array.from(text.matchAll(markdownRegex), match => match[2]);

        // Combine both HTML and markdown URLs
        const urls = [...htmlUrls, ...markdownUrls];

        console.timeEnd('URL Extraction');

        const filePath = document.uri.fsPath;

        console.time('Find Config File');
        const configFile = await findConfigFile(filePath);
        console.timeEnd('Find Config File');

        if (!configFile) {
            vscode.window.showErrorMessage('Config file not found.');
            return;
        }

        console.time('Test URLs');
        await testUrls(urls, document, configFile, filePath);
        console.timeEnd('Test URLs');
    });

    context.subscriptions.push(disposable);
}

async function findConfigFile(startDir) {
    let currentDir = startDir;

    while (currentDir !== path.parse(currentDir).root) {
        const configFilePath = path.join(currentDir, 'config', 'config.toml');

        try {
            const stats = await fs.lstat(configFilePath);
            if (stats.isFile()) {
                return configFilePath;
            }
        } catch (err) {
            // If file doesn't exist, continue searching
        }

        currentDir = path.dirname(currentDir);
    }
    return null; // Return null if not found
}

function extractProductFolder(filePath) {
    const parts = filePath.split('/');
    const contentIndex = parts.indexOf('content');
    let selfFragmentURL = []

    for (let i = parts.length - 1; i > 0; i--) {
        if (parts[i] === 'content') {
            break
        } else {
            selfFragmentURL.unshift(parts[i].replace('.md', ''))
        }
    }

    if (contentIndex > 0) {
        return [parts[contentIndex - 1], selfFragmentURL.join("/")]; // Folder just before /content
    }

    return null; // Return null if the /content folder is not found
}


async function findAbsURL(configFilePath, filePath) {
    try {
        const extracts = extractProductFolder(filePath)
        const productFolder = extracts[0];

        if (!productFolder) {
            throw new Error('Could not extract product folder from file path.');
        }

        // Match the product folder with the product name using the dictionary
        const productName = productFolderDictionary[productFolder];
        if (!productName) {
            throw new Error(`No matching product found for folder: ${productFolder}`);
        }

        const configFileContent = await fs.readFile(configFilePath, 'utf8');

        // Special case check for the exact match of 'publishDir = "public/opsview/cloud"'
        const specialPattern = /publishDir\s*=\s*"public\/opsview\/cloud"/;
        if (specialPattern.test(configFileContent)) {
            return 'https://docs.itrsgroup.com/docs/opsview/cloud';
        }

        const pattern = /publishDir\s*=\s*"public\/([^/]+)\/([\d_]+)"/;
        const match = configFileContent.match(pattern);

        if (match === null) {
            return `https://docs.itrsgroup.com/${productName}`;
        }
        
        const isVersionInProd = await identifyVersion(match, productName);
        

        if (match) {
            const versionNumber = match[2].replace(/_/g, '.');

            if (isVersionInProd === false) {
                return `https://docs.itrsgroup.com/${productName}`;
            } else {
                const removeCurrent = productName.replace("current", "");
                return `https://docs.itrsgroup.com/${removeCurrent}${versionNumber}`;
            }
        } else {
            throw new Error('Pattern not matched in the config file.');
        }
    } catch (err) {
        throw new Error(`Error reading config file: ${err.message}`);
    }
}

async function identifyVersion(match, productName) {

        const configVersionNumber = match[2].replace(/_/g, '.');

        if (productName.includes('current')) { // check if product is versioned
            const getProductName = productName.replace(/\/?(docs|current)\/?/g, '')
            console.log(`https://docs.itrsgroup.com/${productName}`);
            const result =  axios.get(`https://docs.itrsgroup.com/${productName}`).then((d)=>{
                const $ = cheerio.load(String(d.data))
                const productVP = $('.version-picker').data('product');
                console.log(productVP);
                axios.get(`https://docs.itrsgroup.com/versions/${productVP}.json`).then((response) => {
                    return response.data.some((pv) => {
                        const prodVersions = String(pv['path'].match(/\d+\.\d+\.\d+/));
    
                        if (prodVersions === configVersionNumber) {
    
                            return true;
                        }
                        return false;
                    })
                })
            })
            return result
        } else {
            return false // handle unversioned docs
        }

}

function cleanUrl(url) {
    // Regular expression to match the URL and ignore anything after the first quote
    const urlRegex = /^([^\s]+)(?:\s+"[^"]*")?$/;
    const match = url.match(urlRegex);
    return match ? match[1] : url; // Return the cleaned URL
}

async function testUrls(urls, document, configFile, filePath) {

    // Clear previous diagnostics to remove old highlights
    diagnosticCollection.clear(document.uri);

    // Show a loading message
    const loadingMessage = vscode.window.showInformationMessage('Checking URLs... Please wait.', {
        modal: false
    });

    const workingUrls = [];
    const brokenUrls = [];

    // Array to hold all diagnostics
    const diagnostics = [];

    // Retrieve the base URL (absURL) based on the config and file path
    const absURL = await findAbsURL(configFile, filePath);

    // Function to process URLs with concurrency control
    const processUrl = async (url) => {
        const cleanedUrl = cleanUrl(url); // Clean the URL to remove any metadata (like "icon")

        try {
            // Check if it's an external URL (starts with http:// or https://)
            if (cleanedUrl.startsWith('http://') || cleanedUrl.startsWith('https://')) {
                const response = await axios.head(cleanedUrl, {
                    validateStatus: null
                });

                if (response.status === 404 || response.status === 403) {
                    brokenUrls.push(url);
                    diagnostics.push(await createBrokenUrlDiagnostic(url, document, `${response.status} Forbidden/Not Found`, cleanedUrl));
                } else if (response.status >= 200 && response.status < 300) {
                    workingUrls.push(url);
                    diagnostics.push(await createWorkingUrlDiagnostic(url, document, cleanedUrl));
                } else {
                    brokenUrls.push(url);
                    diagnostics.push(await createBrokenUrlDiagnostic(url, document, `${response.status} Error`, cleanedUrl));
                }
            }
            // Check internal URLs (relative paths, starts with /)
            else if (cleanedUrl.startsWith("/")) {
                const fullUrl = absURL + cleanedUrl; // Full URL for checking

                const response = await axios.head(fullUrl, {
                    validateStatus: null
                });

                if (response.status === 404 || response.status === 403) {
                    brokenUrls.push(url);
                    diagnostics.push(await createBrokenUrlDiagnostic(url, document, `${response.status} Forbidden/Not Found`, fullUrl));
                } else if (response.status >= 200 && response.status < 300) {
                    workingUrls.push(url);
                    diagnostics.push(await createWorkingUrlDiagnostic(url, document, fullUrl));
                } else {
                    brokenUrls.push(url);
                    diagnostics.push(await createBrokenUrlDiagnostic(url, document, `${response.status} Error`, fullUrl));
                }
            }
            // handle same page fragment urls starts with #
            else if (cleanedUrl.startsWith("#")) {
                const selfFragmentURLPage = extractProductFolder(filePath)[1]

                const fullUrl = absURL + '/' + selfFragmentURLPage + '/' + cleanedUrl; // fragment url structure

                const response = await axios.head(fullUrl, {
                    validateStatus: null
                });

                if (response.status === 404 || response.status === 403) {
                    brokenUrls.push(url);
                    diagnostics.push(await createBrokenUrlDiagnostic(url, document, `${response.status} Forbidden/Not Found`, fullUrl));
                } else if (response.status >= 200 && response.status < 300) {
                    workingUrls.push(url);
                    diagnostics.push(await createWorkingUrlDiagnostic(url, document, fullUrl));
                } else {
                    brokenUrls.push(url);
                    diagnostics.push(await createBrokenUrlDiagnostic(url, document, `${response.status} Error`, fullUrl));
                }
            }
            // Handle other cases like __tcproject__
            else {
                const fullUrl = absURL + '/' + cleanedUrl; // Prepend '/' and then check the URL

                const response = await axios.head(fullUrl, {
                    validateStatus: null
                });

                if (response.status === 404 || response.status === 403) {
                    brokenUrls.push(url);
                    diagnostics.push(await createBrokenUrlDiagnostic(url, document, `${response.status} Forbidden/Not Found`, fullUrl));
                } else if (response.status >= 200 && response.status < 300) {
                    workingUrls.push(url);
                    diagnostics.push(await createWorkingUrlDiagnostic(url, document, fullUrl));
                } else {
                    brokenUrls.push(url);
                    diagnostics.push(await createBrokenUrlDiagnostic(url, document, `${response.status} Error`, fullUrl));
                }
            }
        } catch (error) {
            // Enhanced error handling
            let message = error.response ? `Status: ${error.response.status}` : `Error: ${error.message}`;
            console.error(`Error checking URL ${cleanedUrl}: ${message}`);

            brokenUrls.push(url);
            diagnostics.push(await createBrokenUrlDiagnostic(url, document, message, absURL + cleanedUrl));
        }
    };

    // Process URLs with concurrency control
    const processUrlsWithConcurrency = async (urls, concurrencyLimit) => {
        const promises = [];
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            const promise = processUrl(url).then(() => {
                // Remove the promise from the array when it's done
                promises.splice(promises.indexOf(promise), 1);
            });
            promises.push(promise);

            // Wait if we have reached the concurrency limit
            if (promises.length >= concurrencyLimit) {
                await Promise.race(promises);
            }
        }
        // Wait for all remaining promises to complete
        await Promise.all(promises);
    };

    try {
        await processUrlsWithConcurrency(urls, CONCURRENCY_LIMIT);
    } finally {
        // Dismiss the loading message
        loadingMessage.then(() => {
            // Loading message will automatically disappear after a few seconds
        });

        // Report all diagnostics at once
        if (diagnostics.length > 0) {
            diagnosticCollection.set(document.uri, diagnostics);
        }

        // Show popup with URLs and their statuses
        const workingResults = workingUrls.map(url => ({
            label: `✅ ${url}`,
            description: 'Working'
        }));

        const brokenResults = brokenUrls.map(url => ({
            label: `❌ ${url}`,
            description: 'Broken'
        }));

        const results = [...workingResults, ...brokenResults];

        // Convert results array to a readable string
        const resultsString = results.map(result => `${result.label} - ${result.description}`).join('\n');

        const header = `Checked ${urls.length} URLs, found ${brokenUrls.length} broken and ${workingUrls.length} working.`;
        const options = {
            detail: resultsString,
            modal: true
        };

        vscode.window.showInformationMessage(header, options, ...["Show results in Problems Tab"]).then(() => {
            vscode.commands.executeCommand('workbench.action.problems.focus')
        });
    }
}

async function createBrokenUrlDiagnostic(url, document, message, fullurl) {
    const range = findUrlRange(url, document);
    return new vscode.Diagnostic(
        range,
        `❌ ${fullurl} - ${message}`,
        vscode.DiagnosticSeverity.Error // Red for broken
    );
}

async function createWorkingUrlDiagnostic(url, document, fullurl) {
    const range = findUrlRange(url, document);
    return new vscode.Diagnostic(
        range,
        `✅ ${fullurl} - Working`,
        vscode.DiagnosticSeverity.Information // Green for working
    );
}

function findUrlRange(url, document) {
    const regex = new RegExp(url, 'g');
    let match;
    const ranges = [];

    while ((match = regex.exec(document.getText())) !== null) {
        const startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + match[0].length);
        ranges.push(new vscode.Range(startPos, endPos));
    }

    return ranges.length > 0 ? ranges[0] : null; // Use the first match range
}

function deactivate() {
    // Dispose of the diagnostic collection when the extension is deactivated
    if (diagnosticCollection) {
        diagnosticCollection.clear();
    }
}

module.exports = {
    activate,
    deactivate,
};