export type OrganizationRole = "owner" | "member";

export interface Database {
	public: {
		Tables: {
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
			organization_invitations: {
				Row: {
					id: string;
					organization_id: string;
					email: string;
					token_hash: string;
					invited_by: string;
					expires_at: string;
					accepted_at: string | null;
					accepted_by: string | null;
					revoked_at: string | null;
					created_at: string;
				};
				Insert: {
					id?: string;
					organization_id: string;
					email: string;
					token_hash: string;
					invited_by: string;
					expires_at: string;
					accepted_at?: string | null;
					accepted_by?: string | null;
					revoked_at?: string | null;
					created_at?: string;
				};
				Update: {
					expires_at?: string;
					accepted_at?: string | null;
					accepted_by?: string | null;
					revoked_at?: string | null;
				};
				Relationships: [
					{
						foreignKeyName: "organization_invitations_organization_id_fkey";
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
			create_organization: { Args: { p_name: string }; Returns: string };
			ensure_personal_workspace: { Args: never; Returns: boolean };
			rename_organization: {
				Args: { p_organization_id: string; p_name: string };
				Returns: undefined;
			};
			create_organization_invitation: {
				Args: { p_organization_id: string; p_email: string };
				Returns: Array<{ token: string; expires_at: string }>;
			};
			revoke_organization_invitation: {
				Args: { p_invitation_id: string };
				Returns: undefined;
			};
			accept_organization_invitation: {
				Args: { p_token: string };
				Returns: string;
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
