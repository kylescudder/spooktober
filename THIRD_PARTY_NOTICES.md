# Third-party component notices

The Better Auth UI shadcn components were installed from its official `radix-nova` registry on 7 November 2026, reusing the adapted copies from the Suggestions app. They are copied into `src/components/auth` (with their shadcn primitives in `src/components/auth/ui`, separate from the watchlist's own `src/components/ui`) and `src/lib/auth`, as intended by the shadcn distribution model. Local adaptations preserve profile drafts across session refreshes, hide the avatar control because Spooktober stores no photos, and connect TanStack Router. The EmailOtp card and OtpField retain tab-scoped email/request-time recovery, wall-clock cooldown/expiry, explicit code verification and a generic invited-email message. Sign-up links are removed because sign-up is disabled, sign-out returns to the watchlist, and redirects are restricted to same-site paths. Social, sign-up, email-change and email-code password-reset views are not used. The components are restyled with the watchlist's dark palette and pumpkin accent.

## Better Auth UI

Source: https://raw.githubusercontent.com/better-auth-ui/better-auth-ui/main/LICENSE

```text
MIT License

Copyright (c) 2025 daveycodez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## shadcn/ui

Source: https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
