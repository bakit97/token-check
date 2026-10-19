'use strict';
const fs=require('node:fs');
// File fsync remains mandatory. Windows does not support fsync on directories.
function syncDirectory(dir){let fd;try{fd=fs.openSync(dir,'r');fs.fsyncSync(fd)}catch(e){if(process.platform!=='win32'||!['EPERM','EISDIR','EACCES'].includes(e.code))throw e}finally{if(fd!=null)fs.closeSync(fd)}}
module.exports={syncDirectory};
