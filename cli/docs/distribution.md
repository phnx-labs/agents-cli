# Installation and release architecture

Pinnable harness versions live in isolated homes behind stable shims. Resolution follows
project pin, user default, then a deterministic installed fallback. Isolated copies have
their own default namespace and cannot be accidentally adopted by later mutations.

Migration is one-way at installation time. Runtime consumers assume the current layout
and do not carry fallback reads for historical paths. Uninstall reverses adoption through
recoverable moves and restores the prior executable surface before removing managed data.

An ordinary agents-cli release promotes the exact package artifact that passed tests. It
does not rebuild at publish time. Attestation binds the artifact to source and test
evidence; unchanged native helpers are content-addressed and reused. Platform signing is
triggered by helper input changes, not every package release.

Build, test, install, and release scripts are the entry points. They own stamping,
packaging, signing, and clean-install verification; hand-rolled substitutes are not
equivalent.
