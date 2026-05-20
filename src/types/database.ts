export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string | null
          email: string
          name: string
          role: string
        }
        Insert: {
          created_at?: string | null
          email: string
          name: string
          role?: string
        }
        Update: {
          created_at?: string | null
          email?: string
          name?: string
          role?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          content: string
          created_at: string | null
          customer_id: string | null
          id: string
          input_tokens: number | null
          message_id: string | null
          model_used: string | null
          output_tokens: number | null
          role: string
        }
        Insert: {
          content: string
          created_at?: string | null
          customer_id?: string | null
          id?: string
          input_tokens?: number | null
          message_id?: string | null
          model_used?: string | null
          output_tokens?: number | null
          role: string
        }
        Update: {
          content?: string
          created_at?: string | null
          customer_id?: string | null
          id?: string
          input_tokens?: number | null
          message_id?: string | null
          model_used?: string | null
          output_tokens?: number | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_flags: {
        Row: {
          created_at: string | null
          customer_id: string
          escalated_to_human: boolean | null
          escalation_reason: string | null
          is_blacklisted: boolean | null
          is_suspicious: boolean | null
          needs_human_review: boolean | null
          vip_status: boolean | null
        }
        Insert: {
          created_at?: string | null
          customer_id: string
          escalated_to_human?: boolean | null
          escalation_reason?: string | null
          is_blacklisted?: boolean | null
          is_suspicious?: boolean | null
          needs_human_review?: boolean | null
          vip_status?: boolean | null
        }
        Update: {
          created_at?: string | null
          customer_id?: string
          escalated_to_human?: boolean | null
          escalation_reason?: string | null
          is_blacklisted?: boolean | null
          is_suspicious?: boolean | null
          needs_human_review?: boolean | null
          vip_status?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_flags_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_rate_limits: {
        Row: {
          customer_id: string
          daily_message_count: number | null
          daily_token_count: number | null
          last_message_at: string | null
          last_reset_at: string | null
          minute_message_count: number | null
        }
        Insert: {
          customer_id: string
          daily_message_count?: number | null
          daily_token_count?: number | null
          last_message_at?: string | null
          last_reset_at?: string | null
          minute_message_count?: number | null
        }
        Update: {
          customer_id?: string
          daily_message_count?: number | null
          daily_token_count?: number | null
          last_message_at?: string | null
          last_reset_at?: string | null
          minute_message_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_rate_limits_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_state: {
        Row: {
          customer_id: string
          state: string
          updated_at: string | null
        }
        Insert: {
          customer_id: string
          state?: string
          updated_at?: string | null
        }
        Update: {
          customer_id?: string
          state?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_state_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          area: string | null
          created_at: string | null
          custom_schedule: Json | null
          delivery_phone: string | null
          id: string
          meal_time_preference: string | null
          name: string | null
          phone_number: string
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          area?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          delivery_phone?: string | null
          id?: string
          meal_time_preference?: string | null
          name?: string | null
          phone_number: string
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          area?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          delivery_phone?: string | null
          id?: string
          meal_time_preference?: string | null
          name?: string | null
          phone_number?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      edit_log: {
        Row: {
          action: string
          changed_by: string
          changes: Json
          created_at: string | null
          entity_id: string
          entity_type: string
          id: string
        }
        Insert: {
          action: string
          changed_by: string
          changes: Json
          created_at?: string | null
          entity_id: string
          entity_type: string
          id?: string
        }
        Update: {
          action?: string
          changed_by?: string
          changes?: Json
          created_at?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
        }
        Relationships: []
      }
      message_templates: {
        Row: {
          description: string | null
          key: string
          template: string
          updated_at: string | null
        }
        Insert: {
          description?: string | null
          key: string
          template: string
          updated_at?: string | null
        }
        Update: {
          description?: string | null
          key?: string
          template?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      orders: {
        Row: {
          area: string
          cancellation_reason: string | null
          cancelled_at: string | null
          completed_at: string | null
          confirmed_at: string | null
          created_at: string | null
          custom_schedule: Json | null
          customer_id: string | null
          delivery_address: string
          id: string
          meal_time_preference: string
          package_size: number
          paid_at: string | null
          pause_until: string | null
          portions_dinner: number | null
          portions_lunch: number | null
          portions_per_delivery: number
          portions_remaining: number
          price_per_portion: number
          reminder_sent_at: string | null
          start_date: string
          status: string
          total_price: number
          updated_at: string | null
        }
        Insert: {
          area: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          customer_id?: string | null
          delivery_address: string
          id?: string
          meal_time_preference: string
          package_size: number
          paid_at?: string | null
          pause_until?: string | null
          portions_dinner?: number | null
          portions_lunch?: number | null
          portions_per_delivery: number
          portions_remaining: number
          price_per_portion: number
          reminder_sent_at?: string | null
          start_date: string
          status?: string
          total_price: number
          updated_at?: string | null
        }
        Update: {
          area?: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          custom_schedule?: Json | null
          customer_id?: string | null
          delivery_address?: string
          id?: string
          meal_time_preference?: string
          package_size?: number
          paid_at?: string | null
          pause_until?: string | null
          portions_dinner?: number | null
          portions_lunch?: number | null
          portions_per_delivery?: number
          portions_remaining?: number
          price_per_portion?: number
          reminder_sent_at?: string | null
          start_date?: string
          status?: string
          total_price?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_tiers: {
        Row: {
          portions: number
          price_per_portion: number
          updated_at: string | null
        }
        Insert: {
          portions: number
          price_per_portion: number
          updated_at?: string | null
        }
        Update: {
          portions?: number
          price_per_portion?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      processed_messages: {
        Row: {
          error: string | null
          message_id: string
          processed_at: string | null
          received_at: string | null
        }
        Insert: {
          error?: string | null
          message_id: string
          processed_at?: string | null
          received_at?: string | null
        }
        Update: {
          error?: string | null
          message_id?: string
          processed_at?: string | null
          received_at?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string | null
          endpoint: string
          id: string
          last_used_at: string | null
          p256dh: string
          user_email: string
        }
        Insert: {
          auth: string
          created_at?: string | null
          endpoint: string
          id?: string
          last_used_at?: string | null
          p256dh: string
          user_email: string
        }
        Update: {
          auth?: string
          created_at?: string | null
          endpoint?: string
          id?: string
          last_used_at?: string | null
          p256dh?: string
          user_email?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string | null
          updated_by: string | null
          value: string
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value: string
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
