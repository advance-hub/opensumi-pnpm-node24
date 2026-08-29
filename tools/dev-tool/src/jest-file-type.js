// file-type 21 exposes a synchronous ESM bridge for Node 24, but Jest's
// resolver does not understand the `module-sync` export condition yet.
// The Jest suite only verifies the text fallback, so a pass-through stream is
// sufficient here. A separate Node 24 runtime test exercises the real package.
exports.fileTypeStream = async (stream) => stream;
