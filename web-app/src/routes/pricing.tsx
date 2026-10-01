import { createFileRoute } from "@tanstack/react-router";
import { PricingPage } from "~/components/pricing-page";

export const Route = createFileRoute("/pricing")({
	head: () => ({
		meta: [{ title: "Pricing — LixRay" }],
	}),
	component: PricingPage,
});
