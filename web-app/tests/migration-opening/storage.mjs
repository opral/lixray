import { OpfsStorage as Original } from "../../../vendor/lix/packages/storage-opfs/dist/index.js";
export class OpfsStorage extends Original {
	get lixStorage() {
		const original = super.lixStorage;
		if (!new URL(location.href).searchParams.has("slowLegacy")) return original;
		return {
			...original,
			moduleUrl: new URL("./delayed-provider.mjs", import.meta.url).href,
			options: {
				...original.options,
				originalModuleUrl: original.moduleUrl,
				originalOptions: original.options,
			},
		};
	}
}
