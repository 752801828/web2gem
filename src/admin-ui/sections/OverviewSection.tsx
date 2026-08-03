import type { JSX } from "preact";
import { MetricCards } from "../components/MetricCards";
import { tr } from "../i18n";

export function OverviewSection(): JSX.Element {
	return (
		<section class="section-block" aria-labelledby="overview-title">
			<div class="section-heading">
				<div>
					<span class="eyebrow">{tr("Overview")}</span>
					<h2 id="overview-title">{tr("Gemini Account Pool")}</h2>
				</div>
			</div>
			<MetricCards />
		</section>
	);
}
