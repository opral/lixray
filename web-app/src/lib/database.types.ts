export type OrganizationRole = "owner" | "member";

export interface Database {
	public: {
		Tables: {
			workspace_members: {
				Row: {
					workspace_id: string;
					user_id: string;
					created_at: string;
				};
				Insert: {
					workspace_id: string;
					user_id: string;
					created_at?: string;
				};
				Update: Record<never, never>;
				Relationships: [
					{
						foreignKeyName: "workspace_members_workspace_id_fkey";
						columns: ["workspace_id"];
						isOneToOne: false;
						referencedRelation: "workspaces";
						referencedColumns: ["id"];
					},
				];
			};
			workspace_share_tokens: {
				Row: {
					id: string;
					workspace_id: string;
					token_hash: string;
					shared_by: string;
					can_edit: boolean;
					revoked_at: string | null;
					created_at: string;
				};
				Insert: {
					id?: string;
					workspace_id: string;
					token_hash: string;
					shared_by: string;
					can_edit?: boolean;
					revoked_at?: string | null;
					created_at?: string;
				};
				Update: {
					revoked_at?: string | null;
				};
				Relationships: [
					{
						foreignKeyName: "workspace_share_tokens_workspace_id_fkey";
						columns: ["workspace_id"];
						isOneToOne: false;
						referencedRelation: "workspaces";
						referencedColumns: ["id"];
					},
				];
			};
			user_workspace_preferences: {
				Row: {
					user_id: string;
					workspace_id: string;
					atelier_layout: unknown;
					updated_at: string;
				};
				Insert: {
					user_id: string;
					workspace_id: string;
					atelier_layout: unknown;
					updated_at?: string;
				};
				Update: {
					atelier_layout?: unknown;
					updated_at?: string;
				};
				Relationships: [];
			};
			user_workspace_review_resolutions: {
				Row: {
					user_id: string;
					workspace_id: string;
					branch_id: string;
					review_id: string;
					file_id: string;
					outcome: "accepted" | "rejected" | "resolved";
					resolved_at: string;
				};
				Insert: {
					user_id: string;
					workspace_id: string;
					branch_id: string;
					review_id: string;
					file_id: string;
					outcome: "accepted" | "rejected" | "resolved";
					resolved_at?: string;
				};
				Update: {
					outcome?: "accepted" | "rejected" | "resolved";
					resolved_at?: string;
				};
				Relationships: [];
			};
			profiles: {
				Row: {
					id: string;
					email: string;
					name: string;
					avatar_url: string | null;
					created_at: string;
					updated_at: string;
				};
				Insert: {
					id: string;
					email: string;
					name: string;
					avatar_url?: string | null;
					created_at?: string;
					updated_at?: string;
				};
				Update: {
					email?: string;
					name?: string;
					avatar_url?: string | null;
					updated_at?: string;
				};
				Relationships: [];
			};
			organizations: {
				Row: {
					id: string;
					name: string;
					handle: string;
					email_domain: string | null;
					personal_owner_id: string | null;
					created_at: string;
					updated_at: string;
				};
				Insert: {
					id?: string;
					name: string;
					handle?: string;
					email_domain?: string | null;
					personal_owner_id?: string | null;
					created_at?: string;
					updated_at?: string;
				};
				Update: {
					name?: string;
					handle?: string;
					email_domain?: string | null;
					personal_owner_id?: string | null;
					updated_at?: string;
				};
				Relationships: [];
			};
			organization_members: {
				Row: {
					organization_id: string;
					user_id: string;
					role: OrganizationRole;
					created_at: string;
				};
				Insert: {
					organization_id: string;
					user_id: string;
					role?: OrganizationRole;
					created_at?: string;
				};
				Update: { role?: OrganizationRole };
				Relationships: [
					{
						foreignKeyName: "organization_members_organization_id_fkey";
						columns: ["organization_id"];
						isOneToOne: false;
						referencedRelation: "organizations";
						referencedColumns: ["id"];
					},
				];
			};
			workspaces: {
				Row: {
					id: string;
					organization_id: string;
					name: string;
					slug: string;
					created_at: string;
					updated_at: string;
					deleted_at: string | null;
				};
				Insert: {
					id?: string;
					organization_id: string;
					name: string;
					slug?: string;
					created_at?: string;
					updated_at?: string;
					deleted_at?: string | null;
				};
				Update: {
					name?: string;
					slug?: string;
					updated_at?: string;
					deleted_at?: string | null;
				};
				Relationships: [
					{
						foreignKeyName: "workspaces_organization_id_fkey";
						columns: ["organization_id"];
						isOneToOne: false;
						referencedRelation: "organizations";
						referencedColumns: ["id"];
					},
				];
			};
		};
		Views: Record<never, never>;
		Functions: {
			list_accessible_workspaces: {
				Args: never;
				Returns: Array<{
					organization_id: string;
					organization_name: string;
					organization_handle: string;
					organization_created_at: string;
					organization_updated_at: string;
					organization_role: OrganizationRole | null;
					workspace_id: string;
					workspace_name: string;
					workspace_slug: string;
					workspace_created_at: string;
					workspace_updated_at: string;
				}>;
			};
			resolve_public_workspace: {
				Args: { p_workspace_id: string };
				Returns: Array<{
					organization_id: string;
					organization_name: string;
					organization_handle: string;
					workspace_id: string;
					workspace_name: string;
					workspace_slug: string;
					can_edit: boolean;
				}>;
			};
			resolve_public_workspace_by_route: {
				Args: { p_organization_handle: string; p_workspace_slug: string };
				Returns: Array<{
					organization_id: string;
					organization_name: string;
					organization_handle: string;
					workspace_id: string;
					workspace_name: string;
					workspace_slug: string;
					can_edit: boolean;
				}>;
			};
			resolve_workspace_share_token: {
				Args: { p_token: string };
				Returns: Array<{
					organization_id: string;
					organization_name: string;
					organization_handle: string;
					workspace_id: string;
					workspace_name: string;
					workspace_slug: string;
					shared_by_name: string | null;
					shared_by_avatar_url: string | null;
					can_edit: boolean;
				}>;
			};
			create_workspace_share_token: {
				Args: { p_workspace_id: string };
				Returns: Array<{ token: string }>;
			};
			accept_workspace_share_token: {
				Args: { p_token: string };
				Returns: string;
			};
			revoke_workspace_share_token: {
				Args: { p_token: string };
				Returns: undefined;
			};
			create_organization: { Args: { p_name: string }; Returns: string };
			ensure_personal_workspace: { Args: never; Returns: boolean };
			ensure_personal_workspace_only: { Args: never; Returns: boolean };
			rename_organization: {
				Args: { p_organization_id: string; p_name: string };
				Returns: undefined;
			};
			set_organization_member_role: {
				Args: {
					p_organization_id: string;
					p_user_id: string;
					p_role: OrganizationRole;
				};
				Returns: undefined;
			};
			remove_organization_member: {
				Args: { p_organization_id: string; p_user_id: string };
				Returns: undefined;
			};
			leave_organization: {
				Args: { p_organization_id: string };
				Returns: undefined;
			};
			delete_workspace: {
				Args: { p_workspace_id: string };
				Returns: undefined;
			};
		};
		Enums: { organization_role: OrganizationRole };
		CompositeTypes: Record<never, never>;
	};
}
