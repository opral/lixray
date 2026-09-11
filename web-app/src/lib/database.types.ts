export type Json =
	| string
	| number
	| boolean
	| null
	| { [key: string]: Json | undefined }
	| Json[];

export type Database = {
	graphql_public: {
		Tables: {
			[_ in never]: never;
		};
		Views: {
			[_ in never]: never;
		};
		Functions: {
			graphql: {
				Args: {
					extensions?: Json;
					operationName?: string;
					query?: string;
					variables?: Json;
				};
				Returns: Json;
			};
		};
		Enums: {
			[_ in never]: never;
		};
		CompositeTypes: {
			[_ in never]: never;
		};
	};
	public: {
		Tables: {
			account_logins: {
				Row: {
					account_id: string;
					auth_user_id: string;
					created_at: string;
				};
				Insert: {
					account_id: string;
					auth_user_id: string;
					created_at?: string;
				};
				Update: {
					account_id?: string;
					auth_user_id?: string;
					created_at?: string;
				};
				Relationships: [
					{
						foreignKeyName: "account_logins_account_id_fkey";
						columns: ["account_id"];
						isOneToOne: false;
						referencedRelation: "accounts";
						referencedColumns: ["id"];
					},
				];
			};
			accounts: {
				Row: {
					created_at: string;
					id: string;
					kind: string;
					primary_namespace_id: string | null;
					status: string;
					updated_at: string;
				};
				Insert: {
					created_at?: string;
					id?: string;
					kind?: string;
					primary_namespace_id?: string | null;
					status?: string;
					updated_at?: string;
				};
				Update: {
					created_at?: string;
					id?: string;
					kind?: string;
					primary_namespace_id?: string | null;
					status?: string;
					updated_at?: string;
				};
				Relationships: [
					{
						foreignKeyName: "accounts_primary_namespace_id_fkey";
						columns: ["primary_namespace_id"];
						isOneToOne: true;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			handles: {
				Row: {
					created_at: string;
					handle: string;
					namespace_id: string | null;
					reason: string | null;
					squat_key: string | null;
					state: string;
				};
				Insert: {
					created_at?: string;
					handle: string;
					namespace_id?: string | null;
					reason?: string | null;
					squat_key?: string | null;
					state?: string;
				};
				Update: {
					created_at?: string;
					handle?: string;
					namespace_id?: string | null;
					reason?: string | null;
					squat_key?: string | null;
					state?: string;
				};
				Relationships: [
					{
						foreignKeyName: "handles_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: true;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			lix_invite_links: {
				Row: {
					created_at: string;
					created_by_account_id: string | null;
					lix_id: string;
					token: string;
				};
				Insert: {
					created_at?: string;
					created_by_account_id?: string | null;
					lix_id: string;
					token: string;
				};
				Update: {
					created_at?: string;
					created_by_account_id?: string | null;
					lix_id?: string;
					token?: string;
				};
				Relationships: [
					{
						foreignKeyName: "lix_invite_links_created_by_account_id_fkey";
						columns: ["created_by_account_id"];
						isOneToOne: false;
						referencedRelation: "accounts";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "lix_invite_links_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: true;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
				];
			};
			lix_members: {
				Row: {
					account_id: string;
					created_at: string;
					lix_id: string;
					role: Database["public"]["Enums"]["lix_role"];
				};
				Insert: {
					account_id: string;
					created_at?: string;
					lix_id: string;
					role?: Database["public"]["Enums"]["lix_role"];
				};
				Update: {
					account_id?: string;
					created_at?: string;
					lix_id?: string;
					role?: Database["public"]["Enums"]["lix_role"];
				};
				Relationships: [
					{
						foreignKeyName: "lix_members_account_id_fkey";
						columns: ["account_id"];
						isOneToOne: false;
						referencedRelation: "accounts";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "lix_members_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: false;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
				];
			};
			lix_publications: {
				Row: {
					created_at: string;
					kind: Database["public"]["Enums"]["lix_publication_kind"];
					lix_id: string;
					path: string;
					published_by_account_id: string;
				};
				Insert: {
					created_at?: string;
					kind: Database["public"]["Enums"]["lix_publication_kind"];
					lix_id: string;
					path: string;
					published_by_account_id: string;
				};
				Update: {
					created_at?: string;
					kind?: Database["public"]["Enums"]["lix_publication_kind"];
					lix_id?: string;
					path?: string;
					published_by_account_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: "lix_publications_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: false;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "lix_publications_published_by_account_id_fkey";
						columns: ["published_by_account_id"];
						isOneToOne: false;
						referencedRelation: "accounts";
						referencedColumns: ["id"];
					},
				];
			};
			lix_share_tokens: {
				Row: {
					can_edit: boolean;
					created_at: string;
					id: string;
					lix_id: string;
					revoked_at: string | null;
					shared_by_account_id: string;
					token_hash: string;
				};
				Insert: {
					can_edit?: boolean;
					created_at?: string;
					id?: string;
					lix_id: string;
					revoked_at?: string | null;
					shared_by_account_id: string;
					token_hash: string;
				};
				Update: {
					can_edit?: boolean;
					created_at?: string;
					id?: string;
					lix_id?: string;
					revoked_at?: string | null;
					shared_by_account_id?: string;
					token_hash?: string;
				};
				Relationships: [
					{
						foreignKeyName: "lix_share_tokens_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: false;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "lix_share_tokens_shared_by_account_id_fkey";
						columns: ["shared_by_account_id"];
						isOneToOne: false;
						referencedRelation: "accounts";
						referencedColumns: ["id"];
					},
				];
			};
			lixes: {
				Row: {
					created_at: string;
					deleted_at: string | null;
					id: string;
					name: string;
					namespace_id: string;
					slug: string;
					slug_squat_key: string | null;
					updated_at: string;
					visibility: Database["public"]["Enums"]["lix_visibility"];
				};
				Insert: {
					created_at?: string;
					deleted_at?: string | null;
					id?: string;
					name: string;
					namespace_id: string;
					slug: string;
					slug_squat_key?: string | null;
					updated_at?: string;
					visibility?: Database["public"]["Enums"]["lix_visibility"];
				};
				Update: {
					created_at?: string;
					deleted_at?: string | null;
					id?: string;
					name?: string;
					namespace_id?: string;
					slug?: string;
					slug_squat_key?: string | null;
					updated_at?: string;
					visibility?: Database["public"]["Enums"]["lix_visibility"];
				};
				Relationships: [
					{
						foreignKeyName: "lixes_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: false;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			mcp_lix_connections: {
				Row: {
					account_id: string;
					connected_at: string;
					last_seen_at: string;
					last_tool: string;
					lix_id: string;
					oauth_client_id: string;
				};
				Insert: {
					account_id: string;
					connected_at?: string;
					last_seen_at?: string;
					last_tool: string;
					lix_id: string;
					oauth_client_id: string;
				};
				Update: {
					account_id?: string;
					connected_at?: string;
					last_seen_at?: string;
					last_tool?: string;
					lix_id?: string;
					oauth_client_id?: string;
				};
				Relationships: [
					{
						foreignKeyName: "mcp_lix_connections_account_id_fkey";
						columns: ["account_id"];
						isOneToOne: false;
						referencedRelation: "accounts";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "mcp_lix_connections_lix_id_fkey";
						columns: ["lix_id"];
						isOneToOne: false;
						referencedRelation: "lixes";
						referencedColumns: ["id"];
					},
				];
			};
			namespace_invite_links: {
				Row: {
					created_at: string;
					created_by_account_id: string | null;
					namespace_id: string;
					token: string;
				};
				Insert: {
					created_at?: string;
					created_by_account_id?: string | null;
					namespace_id: string;
					token: string;
				};
				Update: {
					created_at?: string;
					created_by_account_id?: string | null;
					namespace_id?: string;
					token?: string;
				};
				Relationships: [
					{
						foreignKeyName: "namespace_invite_links_created_by_account_id_fkey";
						columns: ["created_by_account_id"];
						isOneToOne: false;
						referencedRelation: "accounts";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "namespace_invite_links_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: true;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			namespace_members: {
				Row: {
					account_id: string;
					created_at: string;
					namespace_id: string;
					role: Database["public"]["Enums"]["namespace_role"];
				};
				Insert: {
					account_id: string;
					created_at?: string;
					namespace_id: string;
					role?: Database["public"]["Enums"]["namespace_role"];
				};
				Update: {
					account_id?: string;
					created_at?: string;
					namespace_id?: string;
					role?: Database["public"]["Enums"]["namespace_role"];
				};
				Relationships: [
					{
						foreignKeyName: "namespace_members_account_id_fkey";
						columns: ["account_id"];
						isOneToOne: false;
						referencedRelation: "accounts";
						referencedColumns: ["id"];
					},
					{
						foreignKeyName: "namespace_members_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: false;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			namespace_profiles: {
				Row: {
					created_at: string;
					document: Json;
					namespace_id: string;
					updated_at: string;
				};
				Insert: {
					created_at?: string;
					document: Json;
					namespace_id: string;
					updated_at?: string;
				};
				Update: {
					created_at?: string;
					document?: Json;
					namespace_id?: string;
					updated_at?: string;
				};
				Relationships: [
					{
						foreignKeyName: "namespace_profiles_namespace_id_fkey";
						columns: ["namespace_id"];
						isOneToOne: true;
						referencedRelation: "namespaces";
						referencedColumns: ["id"];
					},
				];
			};
			namespaces: {
				Row: {
					created_at: string;
					id: string;
					name: string;
					updated_at: string;
				};
				Insert: {
					created_at?: string;
					id?: string;
					name: string;
					updated_at?: string;
				};
				Update: {
					created_at?: string;
					id?: string;
					name?: string;
					updated_at?: string;
				};
				Relationships: [];
			};
		};
		Views: {
			[_ in never]: never;
		};
		Functions: {
			accept_lix_share_token: { Args: { p_token: string }; Returns: string };
			list_api_tokens: {
				Args: Record<PropertyKey, never>;
				Returns: {
					id: string;
					name: string;
					created_at: string;
					expires_at: string;
				}[];
			};
			generate_api_token: {
				Args: Record<PropertyKey, never>;
				Returns: {
					id: string;
					name: string;
					token: string;
					created_at: string;
					expires_at: string;
				}[];
			};
			delete_api_token: {
				Args: { p_token_id: string };
				Returns: undefined;
			};
			forget_mcp_client: {
				Args: { p_client_id: string };
				Returns: undefined;
			};
			list_mcp_client_connections: {
				Args: never;
				Returns: {
					oauth_client_id: string;
					repository_count: number;
					last_tool: string;
					last_seen_at: string;
					connected_at: string;
				}[];
			};
			authorize_api_token: {
				Args: { p_token: string; p_lix_id: string };
				Returns: {
					account_id: string;
					kind: string;
					profile_uri: string | null;
					name: string;
					allowed: boolean;
				}[];
			};
			accept_namespace_invite: {
				Args: { p_token: string };
				Returns: {
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
				}[];
			};
			bootstrap_personal_namespace: {
				Args: never;
				Returns: {
					created: boolean;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
				}[];
			};
			create_lix_share_token: {
				Args: { p_lix_id: string };
				Returns: {
					token: string;
				}[];
			};
			create_namespace: { Args: { p_name: string }; Returns: string };
			current_account: {
				Args: never;
				Returns: {
					account_id: string;
					kind: string;
					name: string;
					profile_uri: string;
				}[];
			};
			get_lix_invite_link: { Args: { p_lix_id: string }; Returns: string };
			get_namespace_invite_link: {
				Args: { p_namespace_id: string };
				Returns: string;
			};
			is_repository_name_available: {
				Args: {
					p_exclude_lix_id?: string;
					p_name: string;
					p_namespace_id: string;
				};
				Returns: boolean;
			};
			list_accessible_lixes: {
				Args: never;
				Returns: {
					lix_created_at: string;
					lix_id: string;
					lix_name: string;
					lix_role: Database["public"]["Enums"]["lix_role"];
					lix_slug: string;
					lix_updated_at: string;
					lix_visibility: Database["public"]["Enums"]["lix_visibility"];
					namespace_created_at: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_is_personal: boolean;
					namespace_name: string;
					namespace_role: Database["public"]["Enums"]["namespace_role"];
					namespace_updated_at: string;
				}[];
			};
			list_lix_members: {
				Args: { p_lix_id: string };
				Returns: {
					account_id: string;
					avatar_url: string;
					email: string;
					joined_at: string;
					name: string;
					role: Database["public"]["Enums"]["lix_role"];
				}[];
			};
			list_lix_publications: {
				Args: { p_lix_id: string };
				Returns: {
					created_at: string;
					kind: Database["public"]["Enums"]["lix_publication_kind"];
					path: string;
					published_by_account_id: string;
				}[];
			};
			list_namespace_members: {
				Args: { p_namespace_id: string };
				Returns: {
					account_id: string;
					avatar_url: string;
					email: string;
					joined_at: string;
					name: string;
					role: Database["public"]["Enums"]["namespace_role"];
				}[];
			};
			list_public_profile_lixes: {
				Args: { p_namespace_id: string };
				Returns: {
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					lix_updated_at: string;
					namespace_handle: string;
					namespace_id: string;
				}[];
			};
			publish_lix_resource: {
				Args: {
					p_kind: Database["public"]["Enums"]["lix_publication_kind"];
					p_lix_id: string;
					p_path: string;
				};
				Returns: undefined;
			};
			record_mcp_lix_connection: {
				Args: { p_lix_id: string; p_tool_name: string };
				Returns: undefined;
			};
			remove_lix_member: {
				Args: { p_account_id: string; p_lix_id: string };
				Returns: undefined;
			};
			remove_namespace_member: {
				Args: { p_account_id: string; p_namespace_id: string };
				Returns: undefined;
			};
			rename_namespace: {
				Args: { p_name: string; p_namespace_id: string };
				Returns: undefined;
			};
			reset_lix_invite_link: { Args: { p_lix_id: string }; Returns: string };
			reset_namespace_invite_link: {
				Args: { p_namespace_id: string };
				Returns: string;
			};
			resolve_lix_share_token: {
				Args: { p_token: string };
				Returns: {
					can_edit: boolean;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
					path_public: boolean;
					role: Database["public"]["Enums"]["lix_role"];
					shared_by_avatar_url: string;
					shared_by_name: string;
					visibility: Database["public"]["Enums"]["lix_visibility"];
				}[];
			};
			resolve_public_lix: {
				Args: { p_lix_id: string; p_path?: string };
				Returns: {
					can_edit: boolean;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
					path_public: boolean;
					role: Database["public"]["Enums"]["lix_role"];
					visibility: Database["public"]["Enums"]["lix_visibility"];
				}[];
			};
			resolve_public_lix_by_route: {
				Args: {
					p_lix_slug: string;
					p_namespace_handle: string;
					p_path?: string;
				};
				Returns: {
					can_edit: boolean;
					lix_id: string;
					lix_name: string;
					lix_slug: string;
					namespace_handle: string;
					namespace_id: string;
					namespace_name: string;
					path_public: boolean;
					role: Database["public"]["Enums"]["lix_role"];
					visibility: Database["public"]["Enums"]["lix_visibility"];
				}[];
			};
			resolve_public_profile_by_handle: {
				Args: { p_handle: string };
				Returns: {
					namespace_created_at: string;
					namespace_handle: string;
					namespace_id: string;
				}[];
			};
			revoke_lix_share_token: { Args: { p_token: string }; Returns: undefined };
			set_lix_member_role: {
				Args: {
					p_account_id: string;
					p_lix_id: string;
					p_role: Database["public"]["Enums"]["lix_role"];
				};
				Returns: undefined;
			};
			set_lix_visibility: {
				Args: {
					p_lix_id: string;
					p_visibility: Database["public"]["Enums"]["lix_visibility"];
				};
				Returns: undefined;
			};
			unpublish_lix_resource: {
				Args: {
					p_kind: Database["public"]["Enums"]["lix_publication_kind"];
					p_lix_id: string;
					p_path: string;
				};
				Returns: undefined;
			};
		};
		Enums: {
			lix_publication_kind: "file" | "directory";
			lix_role: "admin" | "member";
			lix_visibility: "private" | "public";
			namespace_role: "owner" | "member";
		};
		CompositeTypes: {
			[_ in never]: never;
		};
	};
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
	keyof Database,
	"public"
>];

export type Tables<
	DefaultSchemaTableNameOrOptions extends
		| keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
		| { schema: keyof DatabaseWithoutInternals },
	TableName extends DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
				DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
		: never = never,
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
			DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
			Row: infer R;
		}
		? R
		: never
	: DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
				DefaultSchema["Views"])
		? (DefaultSchema["Tables"] &
				DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
				Row: infer R;
			}
			? R
			: never
		: never;

export type TablesInsert<
	DefaultSchemaTableNameOrOptions extends
		| keyof DefaultSchema["Tables"]
		| { schema: keyof DatabaseWithoutInternals },
	TableName extends DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
		: never = never,
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
			Insert: infer I;
		}
		? I
		: never
	: DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
		? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
				Insert: infer I;
			}
			? I
			: never
		: never;

export type TablesUpdate<
	DefaultSchemaTableNameOrOptions extends
		| keyof DefaultSchema["Tables"]
		| { schema: keyof DatabaseWithoutInternals },
	TableName extends DefaultSchemaTableNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
		: never = never,
> = DefaultSchemaTableNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
			Update: infer U;
		}
		? U
		: never
	: DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
		? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
				Update: infer U;
			}
			? U
			: never
		: never;

export type Enums<
	DefaultSchemaEnumNameOrOptions extends
		| keyof DefaultSchema["Enums"]
		| { schema: keyof DatabaseWithoutInternals },
	EnumName extends DefaultSchemaEnumNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
		: never = never,
> = DefaultSchemaEnumNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
	: DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
		? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
		: never;

// Supabase emits `never` in this union while the public schema has no composites.
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
export type CompositeTypes<
	PublicCompositeTypeNameOrOptions extends
		| keyof DefaultSchema["CompositeTypes"]
		| { schema: keyof DatabaseWithoutInternals },
	CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
		schema: keyof DatabaseWithoutInternals;
	}
		? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
		: never = never,
> = PublicCompositeTypeNameOrOptions extends {
	schema: keyof DatabaseWithoutInternals;
}
	? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
	: PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
		? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
		: never;
/* eslint-enable @typescript-eslint/no-redundant-type-constituents */

export const Constants = {
	graphql_public: {
		Enums: {},
	},
	public: {
		Enums: {
			lix_publication_kind: ["file", "directory"],
			lix_role: ["admin", "member"],
			lix_visibility: ["private", "public"],
			namespace_role: ["owner", "member"],
		},
	},
} as const;
