import { Link } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";
import { Fragment } from "react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";

export function ExplorerBreadcrumb({ dirPath }: { dirPath: string }) {
	const segments = dirPath.split("/").filter(Boolean);
	const crumbs = segments.map((name, index) => ({
		name,
		path: `/${segments.slice(0, index + 1).join("/")}/`,
	}));

	return (
		<Breadcrumb data-testid="explorer-breadcrumb">
			<BreadcrumbList>
				<BreadcrumbItem>
					{crumbs.length === 0 ? (
						<BreadcrumbPage className="inline-flex items-center gap-1.5">
							<HardDrive aria-hidden="true" className="size-3.5" />
							Home
						</BreadcrumbPage>
					) : (
						<BreadcrumbLink asChild>
							<Link
								to="/"
								search={{}}
								className="inline-flex items-center gap-1.5"
							>
								<HardDrive aria-hidden="true" className="size-3.5" />
								Home
							</Link>
						</BreadcrumbLink>
					)}
				</BreadcrumbItem>
				{crumbs.map((crumb, index) => (
					<Fragment key={crumb.path}>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							{index === crumbs.length - 1 ? (
								<BreadcrumbPage>{crumb.name}</BreadcrumbPage>
							) : (
								<BreadcrumbLink asChild>
									<Link to="/" search={{ dir: crumb.path }}>
										{crumb.name}
									</Link>
								</BreadcrumbLink>
							)}
						</BreadcrumbItem>
					</Fragment>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
