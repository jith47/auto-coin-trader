// Polyfill File for Node 18
if (typeof globalThis.File === 'undefined') {
    globalThis.File = class File {
        constructor(bits, name, options) {
            this.bits = bits;
            this.name = name;
            this.options = options;
        }
    };
}
