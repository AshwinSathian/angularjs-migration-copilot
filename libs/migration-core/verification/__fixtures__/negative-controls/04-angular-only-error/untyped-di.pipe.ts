// Planted negative control #4: valid TypeScript that only the Angular compiler rejects.
// `tsc --noEmit` exits 0 on this file; `ngc` reports NG2003 (no injection token for `layoutPaths`).
import { Pipe } from '@angular/core';

@Pipe({ name: 'appImage' })
export class AppImagePipe {
  constructor(private layoutPaths: any) {}

  transform(input: string): string {
    return this.layoutPaths.images.root + input;
  }
}
