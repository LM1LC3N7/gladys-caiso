# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
ships no third-party code besides its npm dependencies (the Gladys integration
SDK, Apache-2.0).

## gridstatus (reference only)

The endpoints of the California ISO, the OASIS query of the real-time 5-minute
prices (`PRC_INTVL_LMP`, version 3, market `RTM`, the three trading hub nodes,
`resultformat=6`), the fields of `stats.txt` (`gridstatus`, `slotDate`) and the
way OASIS signals "no data" (an XML file in the ZIP) were read in gridstatus
0.37.0 (<https://github.com/gridstatus/gridstatus>, `gridstatus/caiso/`).
No code was copied: the parsers are written in JavaScript from the files
themselves (`src/outlook.js`, `src/oasis.js`, `src/zip.js`).

```
BSD 3-Clause License

Copyright 2022 James Max Kanter

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## California ISO data

Read at run time, never shipped: Today's Outlook
(<https://www.caiso.com/outlook/current/stats.txt>) and OASIS
(<https://oasis.caiso.com/oasisapi/SingleZip>). Data © California ISO; this
integration is not affiliated with nor endorsed by the California ISO.

The test files (`test/helpers/app.js`) copy the layouts of the real answers
(keys, columns, file names) with made-up numbers; no capture of the ISO's data
is in this repository.
